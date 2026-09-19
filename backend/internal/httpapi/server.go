// HTTP surface: the built UI at /, the OIDC endpoints at /api/auth/*, and the
// session-guarded RPC proxy at /transmission/rpc.
package httpapi

import (
	"bytes"
	"encoding/json"
	"html"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/trick77/transmission-ui/backend/internal/auth"
	"github.com/trick77/transmission-ui/backend/internal/config"
)

// OIDC is the part of auth.OIDCService the server uses, so tests can fake it.
type OIDC interface {
	StartLogin(http.ResponseWriter, *http.Request)
	HandleCallback(*http.Request) (auth.Claims, error)
	ClearTransientCookies(http.ResponseWriter)
}

type Server struct {
	cfg      config.Config
	oidc     OIDC
	sessions *auth.SessionCodec
	rpc      http.Handler
	ui       fs.FS
	log      *slog.Logger
}

func New(cfg config.Config, oidc OIDC, sessions *auth.SessionCodec, rpc http.Handler, ui fs.FS, log *slog.Logger) *Server {
	return &Server{cfg: cfg, oidc: oidc, sessions: sessions, rpc: rpc, ui: ui, log: log}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	// The reverse proxy forwards the prefix rather than stripping it (the other
	// services on the shared host work the same way), so mount every route
	// under it. Empty base path means the app owns the whole origin.
	p := func(pattern string) string {
		if s.cfg.BasePath == "" {
			return pattern
		}
		method, rest, found := strings.Cut(pattern, " ")
		if !found {
			return s.cfg.BasePath + pattern
		}
		return method + " " + s.cfg.BasePath + rest
	}
	mux.HandleFunc(p("GET /api/auth/login"), s.handleLogin)
	mux.HandleFunc(p("GET /api/auth/callback"), s.handleCallback)
	mux.HandleFunc(p("GET /api/auth/logout"), s.handleLogout)
	mux.HandleFunc(p("GET /api/auth/me"), s.handleMe)
	if s.cfg.AuthMode == config.AuthModeForm {
		mux.HandleFunc(p("GET /login"), s.handleLoginPage)
		mux.HandleFunc(p("POST /login"), s.handleLoginSubmit)
		mux.Handle(p("GET /login-assets/"), loginAssetHandler(s.cfg.BasePath))
	}
	mux.Handle(p("POST /transmission/rpc"), s.requireAuth(s.rpc))
	// Without this, a GET on the RPC path falls through to the SPA handler and
	// answers 200 with index.html. The daemon's RPC is POST-only. A methodless
	// pattern here would conflict with "GET /", so spell the method out.
	mux.HandleFunc(p("GET /transmission/rpc"), func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	})
	mux.Handle(p("GET /"), s.staticHandler())
	return mux
}

// requireAuth rejects unauthenticated RPC with 401. The UI turns that into a
// redirect to /api/auth/login rather than showing a browser auth prompt.
func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, err := s.sessions.Decode(r)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if !claims.HasGroup(s.cfg.OIDCAllowedGroup) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	// Form mode has its own page; the UI's Sign in button lands here either way.
	if s.cfg.AuthMode == config.AuthModeForm {
		http.Redirect(w, r, s.cfg.BasePath+"/login", http.StatusFound)
		return
	}
	s.oidc.StartLogin(w, r)
}

func (s *Server) handleCallback(w http.ResponseWriter, r *http.Request) {
	// Only oidc mode has a provider; s.oidc is nil otherwise, and a stale
	// bookmark hitting this route would panic.
	if s.oidc == nil {
		http.NotFound(w, r)
		return
	}
	claims, err := s.oidc.HandleCallback(r)
	s.oidc.ClearTransientCookies(w)
	if err != nil {
		s.log.Warn("oidc callback failed", "err", err)
		http.Error(w, "authentication failed", http.StatusUnauthorized)
		return
	}
	if !claims.HasGroup(s.cfg.OIDCAllowedGroup) {
		s.log.Warn("login rejected: missing group",
			"subject", claims.Subject, "required", s.cfg.OIDCAllowedGroup)
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	s.issueSession(w, r, claims)
}

func (s *Server) issueSession(w http.ResponseWriter, r *http.Request, claims auth.Claims) {
	cookie, err := s.sessions.Encode(claims)
	if err != nil {
		s.log.Error("encode session", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, cookie)
	http.Redirect(w, r, s.cfg.BasePath+"/", http.StatusFound)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, s.sessions.ClearCookie())
	target := s.cfg.OIDCPostLogoutRedirectURL
	if s.cfg.AuthMode == config.AuthModeForm {
		// Root would just bounce off the session check and back to the form;
		// go there directly so the user sees they are signed out.
		target = s.cfg.BasePath + "/login"
	}
	if target == "" {
		target = s.cfg.BasePath + "/"
	}
	http.Redirect(w, r, target, http.StatusFound)
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	claims, err := s.sessions.Decode(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// Same check requireAuth applies: a session issued before the group was
	// revoked, or under a laxer allowed-group setting, must not still read as
	// signed in here while every RPC call returns 403.
	if !claims.HasGroup(s.cfg.OIDCAllowedGroup) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"subject":  claims.Subject,
		"username": claims.PreferredUsername,
		"name":     claims.Name,
		"email":    claims.Email,
		"groups":   claims.Groups,
	})
}

// staticHandler serves the embedded bundle, falling back to index.html so the
// SPA's client-side routes resolve.
func (s *Server) staticHandler() http.Handler {
	var files http.Handler = http.FileServer(http.FS(s.ui))
	if s.cfg.BasePath != "" {
		// FileServer resolves against the URL path, which still carries the
		// prefix the proxy forwarded.
		files = http.StripPrefix(s.cfg.BasePath, files)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The proxy forwards the prefix, so take it off before looking the file
		// up in the bundle.
		name := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, s.cfg.BasePath), "/")
		if name == "" {
			name = "index.html"
		}
		info, err := fs.Stat(s.ui, name)
		switch {
		case err == nil && !info.IsDir():
			// A real file: serve it as is. Hashed asset names are immutable.
		case isAssetRequest(name):
			// A missing asset must 404, not fall back. Returning index.html
			// with 200 for a stale /assets/index-<hash>.js hands the browser
			// HTML where it expects a module, and the app dies on a MIME error
			// until a hard refresh instead of surfacing the real problem.
			http.NotFound(w, r)
			return
		default:
			// A client-side route: hand back the shell.
			r = r.Clone(r.Context())
			r.URL.Path = s.cfg.BasePath + "/"
			name = "index.html"
		}
		if name == "index.html" {
			// Form mode owns a login page, so send an unauthenticated visitor
			// there rather than loading the app just to show it a banner. This
			// sits after the switch so it covers client-side routes too, not
			// only "/" -- otherwise a deep link still rendered the shell.
			// OIDC mode leaves the shell to render: its sign-in leaves this
			// origin entirely.
			if s.cfg.AuthMode == config.AuthModeForm {
				if _, err := s.sessions.Decode(r); err != nil {
					http.Redirect(w, r, s.cfg.BasePath+"/login", http.StatusFound)
					return
				}
			}
			// Tell the app where it is mounted. It cannot infer this from the
			// URL: on the bundle-only path the daemon serves the UI from
			// /transmission/web/ while its RPC stays at /transmission/rpc.
			// (serveIndexWithBase sets its own no-cache header.)
			if s.cfg.BasePath != "" {
				s.serveIndexWithBase(w, r)
				return
			}
			// The index names the hashed bundles, so it must never be cached
			// heuristically: a stale one asks for assets a redeploy removed.
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}

// serveIndexWithBase writes index.html with the base-path meta tag filled in.
func (s *Server) serveIndexWithBase(w http.ResponseWriter, r *http.Request) {
	body, err := fs.ReadFile(s.ui, "index.html")
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	patched := bytes.Replace(body,
		[]byte(`<meta name="tmui-base" content="">`),
		[]byte(`<meta name="tmui-base" content="`+html.EscapeString(s.cfg.BasePath)+`">`), 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(patched))
}

// isAssetRequest reports whether a path should 404 rather than fall back to the
// SPA shell: anything under the bundle's asset directory, or any path with a
// file extension.
func isAssetRequest(name string) bool {
	return strings.HasPrefix(name, "assets/") || path.Ext(name) != ""
}

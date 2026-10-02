// HTTP surface: the built UI at /, the OIDC endpoints at /api/auth/*, and the
// session-guarded RPC proxy at /transmission/rpc.
package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"html"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"strings"
	"sync"
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

// Server holds everything the HTTP routes need: configuration, the auth
// pieces, the RPC proxy and the embedded UI.
type Server struct {
	cfg      config.Config
	oidc     OIDC
	sessions *auth.SessionCodec
	rpc      http.Handler
	ui       fs.FS
	log      *slog.Logger

	// index.html with the base path filled in, and its validator. The bundle is
	// embedded, so both are fixed for the life of the process.
	index     []byte
	indexETag string

	// Form login: when each client's next attempt may be judged; see loginTurn.
	loginMu      sync.Mutex
	loginNext    map[string]time.Time
	loginPenalty time.Duration
}

const baseMeta = `<meta name="tmui-base" content="">`

// New builds a Server from its dependencies. It fails when the bundle cannot
// be told where it is mounted: under a base path the UI would then call the
// RPC at the origin root and miss the reverse proxy's route.
func New(cfg config.Config, oidc OIDC, sessions *auth.SessionCodec, rpc http.Handler, ui fs.FS, log *slog.Logger) (*Server, error) {
	s := &Server{cfg: cfg, oidc: oidc, sessions: sessions, rpc: rpc, ui: ui, log: log,
		loginNext: map[string]time.Time{}, loginPenalty: loginPenalty}
	index, err := fs.ReadFile(ui, "index.html")
	if err != nil {
		return nil, errors.New("the UI bundle has no index.html")
	}
	if cfg.BasePath != "" {
		// Tell the app where it is mounted. It cannot infer this from the URL:
		// on the bundle-only path the daemon serves the UI from
		// /transmission/web/ while its RPC stays at /transmission/rpc.
		if !bytes.Contains(index, []byte(baseMeta)) {
			return nil, errors.New("index.html has no " + baseMeta + " tag to carry the base path " + cfg.BasePath)
		}
		index = bytes.Replace(index, []byte(baseMeta),
			[]byte(`<meta name="tmui-base" content="`+html.EscapeString(cfg.BasePath)+`">`), 1)
	}
	s.index = index
	s.indexETag = etagOf(index)
	return s, nil
}

// etagOf is a strong validator over the content. The embedded files carry no
// modification time, so without one a browser can never get a 304.
func etagOf(b []byte) string {
	sum := sha256.Sum256(b)
	return `"` + hex.EncodeToString(sum[:8]) + `"`
}

// Handler returns the mux serving every route, mounted under the configured
// base path.
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
	// The session cookie is SameSite=Lax, which already keeps it off cross-site
	// POSTs. This refuses them outright, by Sec-Fetch-Site or Origin, so a
	// cross-site page can neither drive the daemon nor sign a visitor in as
	// someone else. Requests without either header (curl, scripts) pass.
	sameOrigin := http.NewCrossOriginProtection()

	mux.HandleFunc(p("GET /api/auth/login"), s.handleLogin)
	mux.HandleFunc(p("GET /api/auth/callback"), s.handleCallback)
	// GET on purpose. The UI has no sign-out control, so this is reached by
	// typing the URL, which a POST-only route would make impossible. The cost
	// is that a cross-site link can sign the user out; it cannot do more.
	mux.HandleFunc(p("GET /api/auth/logout"), s.handleLogout)
	// Registered in every mode: oidc serves the same page without the form, and
	// its fonts, background and icon come from /login-assets/ either way.
	mux.HandleFunc(p("GET /login"), s.handleLoginPage)
	mux.Handle(p("POST /login"), sameOrigin.Handler(http.HandlerFunc(s.handleLoginSubmit)))
	mux.Handle(p("GET /login-assets/"), loginAssetHandler(s.cfg.BasePath))
	mux.Handle(p("POST /transmission/rpc"), sameOrigin.Handler(s.requireAuth(s.rpc)))
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

// authorize is the one place a request's session is judged: 200 with a valid
// session whose holder is in the allowed group, 401 without a session, 403 with
// one that lacks the group (revoked since, or issued under a laxer setting).
// Every gate asks here, so no two of them can disagree about who is signed in.
func (s *Server) authorize(r *http.Request) int {
	claims, err := s.sessions.Decode(r)
	if err != nil {
		return http.StatusUnauthorized
	}
	if !claims.HasGroup(s.cfg.OIDCAllowedGroup) {
		return http.StatusForbidden
	}
	return http.StatusOK
}

// requireAuth rejects unauthenticated RPC with 401. The UI turns that into a
// redirect to /api/auth/login rather than showing a browser auth prompt.
func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if status := s.authorize(r); status != http.StatusOK {
			http.Error(w, strings.ToLower(http.StatusText(status)), status)
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

// handleLogout ends this app's session. It does not end the identity
// provider's: the next sign-in may go straight through.
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

// staticHandler serves the embedded bundle, falling back to index.html so the
// SPA's client-side routes resolve.
func (s *Server) staticHandler() http.Handler {
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
			// A real file: serve it as is.
		case isAssetRequest(name):
			// A missing asset must 404, not fall back. Returning index.html
			// with 200 for a stale /assets/index-<hash>.js hands the browser
			// HTML where it expects a module, and the app dies on a MIME error
			// until a hard refresh instead of surfacing the real problem.
			http.NotFound(w, r)
			return
		default:
			// A client-side route: hand back the shell.
			name = "index.html"
		}
		if name == "index.html" {
			// The shell is privileged: handing it to an anonymous visitor renders
			// the whole UI and leaks the layout, with only the RPC refusing. This
			// sits after the switch so it covers client-side routes too, not
			// only "/" -- otherwise a deep link still rendered the shell.
			//
			// Form mode redirects to the page that owns the form. OIDC renders
			// the same card without one, with 200 and not 401: the container
			// healthcheck probes "/" and counts >= 400 as unhealthy.
			if s.authorize(r) != http.StatusOK {
				if s.cfg.AuthMode == config.AuthModeForm {
					http.Redirect(w, r, s.cfg.BasePath+"/login", http.StatusFound)
					return
				}
				s.renderLogin(w, http.StatusOK, "")
				return
			}
			// The index names the hashed bundles, so it must never be served
			// from cache unchecked: a stale one asks for assets a redeploy
			// removed. no-cache plus the ETag makes that check a 304.
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("ETag", s.indexETag)
			http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(s.index))
			return
		}
		// Vite puts a content hash in every name under assets/, so a URL there
		// never changes what it answers. Without this the browser has nothing
		// to cache by -- embedded files carry no modification time -- and
		// refetches the whole bundle and both fonts on every load.
		if strings.HasPrefix(name, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		// Go's mime table has no entry for .webmanifest, so net/http sniffs the
		// JSON and serves it as text/plain. Chrome then refuses the manifest and
		// the app is not installable. Set it here rather than registering the
		// type globally: this is the only file of its kind in the bundle.
		if path.Ext(name) == ".webmanifest" {
			w.Header().Set("Content-Type", "application/manifest+json")
		}
		http.ServeFileFS(w, r, s.ui, name) //nolint:gosec // name was just resolved by fs.Stat inside the embedded bundle; an fs.FS has no path outside itself to traverse to
	})
}

// isAssetRequest reports whether a path should 404 rather than fall back to the
// SPA shell: anything under the bundle's asset directory, or any path with a
// file extension.
func isAssetRequest(name string) bool {
	return strings.HasPrefix(name, "assets/") || path.Ext(name) != ""
}

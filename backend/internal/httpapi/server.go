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

	"github.com/trick77/ship/kit/auth"
	"github.com/trick77/ship/kit/httpx"
	"github.com/trick77/ship/kit/logging"
	"github.com/trick77/ship/kit/spa"
	"github.com/trick77/transmission-ui/backend/internal/config"
)

// OIDC is the part of auth.OIDC the server uses, so tests can fake it.
type OIDC interface {
	Start(http.ResponseWriter, *http.Request)
	Callback(http.ResponseWriter, *http.Request) (auth.Claims, error)
}

// cookiePrefix names every cookie this app sets, so a sibling app on the same
// parent domain cannot overwrite them.
const cookiePrefix = "tmui_"

// SessionCookieName is the name of the browser cookie carrying the session.
const SessionCookieName = cookiePrefix + "session"

// cookiePath scopes the cookies to the app's prefix: on a shared host the
// sibling apps live at other prefixes and have no business receiving them.
func cookiePath(basePath string) string {
	return basePath + "/"
}

// NewSessions is the signed-cookie session store for cfg. The claims travel in
// the cookie, so there is no session table; rotating BACKEND_SESSION_SECRET
// signs everyone out.
func NewSessions(cfg config.Config) (*auth.Sessions, error) {
	return auth.NewSessions(auth.SessionConfig{
		Name:      SessionCookieName,
		Key:       cfg.SessionKey,
		TTL:       cfg.SessionTTL,
		Path:      cookiePath(cfg.BasePath),
		Secure:    cfg.SecureCookies,
		KeepGroup: cfg.OIDCAllowedGroup,
	})
}

// OIDCConfig is the relying party's configuration for cfg. The group is checked
// at the callback here and again on every request by authorize.
func OIDCConfig(cfg config.Config) auth.OIDCConfig {
	return auth.OIDCConfig{
		Issuer:       cfg.OIDCIssuer,
		ClientID:     cfg.OIDCClientID,
		ClientSecret: cfg.OIDCClientSecret,
		RedirectURL:  cfg.OIDCRedirectURL,
		Group:        cfg.OIDCAllowedGroup,
		CookiePrefix: cookiePrefix,
		CookiePath:   cookiePath(cfg.BasePath),
		Secure:       cfg.SecureCookies,
	}
}

// Server holds everything the HTTP routes need: configuration, the auth
// pieces, the RPC proxy and the embedded UI.
type Server struct {
	cfg      config.Config
	oidc     OIDC
	sessions *auth.Sessions
	rpc      http.Handler
	ui       fs.FS
	log      *slog.Logger
	// ready are the readiness checks /readyz runs.
	ready []httpx.Check

	// baseTag is the tmui-base meta tag with the base path filled in, nil when
	// the app owns the whole origin.
	baseTag []byte

	// Form login: spaces one client's attempts apart; see handleLoginSubmit.
	throttle *httpx.Throttle
}

const baseMeta = `<meta name="tmui-base" content="">`

// New builds a Server from its dependencies. It fails when the bundle cannot
// be told where it is mounted: under a base path the UI would then call the
// RPC at the origin root and miss the reverse proxy's route.
func New(cfg config.Config, oidc OIDC, sessions *auth.Sessions, rpc http.Handler, ui fs.FS, log *slog.Logger,
	ready ...httpx.Check) (*Server, error) {
	if log == nil {
		log = slog.Default()
	}
	s := &Server{cfg: cfg, oidc: oidc, sessions: sessions, rpc: rpc, ui: ui, log: log, ready: ready,
		throttle: httpx.NewThrottle(loginGap, loginMaxWait)}
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
		s.baseTag = []byte(`<meta name="tmui-base" content="` + html.EscapeString(cfg.BasePath) + `">`)
	}
	return s, nil
}

// withBase fills the base path into the shell; bytes.Replace returns a copy,
// so the embedded index is never modified.
func (s *Server) withBase(index []byte, _ *http.Request) []byte {
	if s.baseTag == nil {
		return index
	}
	return bytes.Replace(index, []byte(baseMeta), s.baseTag, 1)
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
	// The session cookie is SameSite=Lax, which still sends it on a form POST
	// from a sibling subdomain. CrossOrigin refuses cross-site POSTs outright,
	// by Sec-Fetch-Site or Origin, so a cross-site page can neither drive the
	// daemon nor sign a visitor in as someone else. Requests without either
	// header (curl, scripts) pass.

	// Liveness and readiness, under the prefix like every other route: the
	// container healthcheck probes BasePath+"/healthz", so a misrouted mount
	// fails it.
	probes := http.NewServeMux()
	httpx.Health(probes, s.log, s.ready...)
	mux.Handle(p("GET /healthz"), http.StripPrefix(s.cfg.BasePath, probes))
	mux.Handle(p("GET /readyz"), http.StripPrefix(s.cfg.BasePath, probes))

	mux.HandleFunc(p("GET /api/auth/login"), s.handleLogin)
	mux.HandleFunc(p("GET /api/auth/callback"), s.handleCallback)
	// GET on purpose. The UI has no sign-out control, so this is reached by
	// typing the URL, which a POST-only route would make impossible. The cost
	// is that a cross-site link can sign the user out; it cannot do more.
	mux.HandleFunc(p("GET /api/auth/logout"), s.handleLogout)
	// Registered in every mode: oidc serves the same page without the form, and
	// its fonts, background and icon come from /login-assets/ either way.
	mux.HandleFunc(p("GET /login"), s.handleLoginPage)
	mux.Handle(p("POST /login"), httpx.CrossOrigin(http.HandlerFunc(s.handleLoginSubmit)))
	mux.Handle(p("GET /login-assets/"), loginAssetHandler(s.cfg.BasePath))
	// Unauthenticated RPC gets a 401, which the UI turns into a redirect to
	// /api/auth/login rather than a browser auth prompt.
	guard := s.sessions.Guard(s.cfg.OIDCAllowedGroup, refuse(http.StatusUnauthorized), refuse(http.StatusForbidden))
	mux.Handle(p("POST /transmission/rpc"), httpx.CrossOrigin(guard(s.rpc)))
	// Without this, a GET on the RPC path falls through to the SPA handler and
	// answers 200 with index.html. The daemon's RPC is POST-only. A methodless
	// pattern here would conflict with "GET /", so spell the method out.
	mux.HandleFunc(p("GET /transmission/rpc"), func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Allow", "POST")
		httpx.WriteError(w, http.StatusMethodNotAllowed, "method not allowed")
	})
	// The proxy forwards the prefix, so take it off before the bundle lookup.
	mux.Handle(p("GET /"), http.StripPrefix(s.cfg.BasePath, spa.Handler(s.ui, spa.Options{
		Routes: appRoute,
		Gate:   s.gate,
		Index:  s.withBase,
	})))
	return mux
}

// refuse answers a guarded request with the JSON error for status.
func refuse(status int) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteError(w, status, strings.ToLower(http.StatusText(status)))
	})
}

// authorized is the one place a request's session is judged (valid, and in the
// allowed group), so the shell, the login page and the RPC never disagree.
func (s *Server) authorized(r *http.Request) bool {
	_, status := s.sessions.Authorize(r, s.cfg.OIDCAllowedGroup)
	return status == http.StatusOK
}

// appRoute: client-side routes are extensionless. Anything with an extension
// is a file, and a missing one must 404 rather than get the shell: a stale
// /assets/index-<hash>.js answered with HTML kills the app on a MIME error,
// and /favicon.ico probes would get HTML posing as an image.
func appRoute(p string) bool {
	return path.Ext(p) == "" || p == "/index.html"
}

// gate keeps the shell from anonymous visitors, on every client-side route and
// not only "/": handing it out renders the whole UI and leaks the layout, with
// only the RPC refusing. Form mode redirects to the page that owns the form;
// OIDC renders the same card without one, with 200 and not 401: it is a page a
// browser lands on, not an API answer.
func (s *Server) gate(w http.ResponseWriter, r *http.Request) bool {
	if s.authorized(r) {
		return true
	}
	if s.cfg.AuthMode == config.AuthModeForm {
		http.Redirect(w, r, s.cfg.BasePath+"/login", http.StatusFound)
		return false
	}
	s.renderLogin(w, http.StatusOK, "")
	return false
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	// Form mode has its own page; the UI's Sign in button lands here either way.
	if s.cfg.AuthMode == config.AuthModeForm {
		http.Redirect(w, r, s.cfg.BasePath+"/login", http.StatusFound)
		return
	}
	s.oidc.Start(w, r)
}

func (s *Server) handleCallback(w http.ResponseWriter, r *http.Request) {
	// Only oidc mode has a provider; s.oidc is nil otherwise, and a stale
	// bookmark hitting this route would panic.
	if s.oidc == nil {
		httpx.WriteError(w, http.StatusNotFound, "not found")
		return
	}
	// Callback clears the transient cookies whatever the outcome, and refuses a
	// user outside the allowed group, handing back the verified claims so the
	// refusal names who was turned away.
	claims, err := s.oidc.Callback(w, r)
	switch {
	case errors.Is(err, auth.ErrNotInGroup):
		s.log.Warn("login rejected: missing group", "subject", claims.Subject,
			"username", claims.PreferredUsername, "required", s.cfg.OIDCAllowedGroup)
		httpx.WriteError(w, http.StatusForbidden, "forbidden")
		return
	case err != nil:
		s.log.Warn("oidc callback failed", logging.Err(err))
		httpx.WriteError(w, http.StatusUnauthorized, "authentication failed")
		return
	}
	s.issueSession(w, r, claims)
}

func (s *Server) issueSession(w http.ResponseWriter, r *http.Request, claims auth.Claims) {
	if err := s.sessions.Issue(w, claims); err != nil {
		s.log.Error("issue session", logging.Err(err))
		httpx.WriteError(w, http.StatusInternalServerError, "internal error")
		return
	}
	http.Redirect(w, r, s.cfg.BasePath+"/", http.StatusFound)
}

// handleLogout ends this app's session. It does not end the identity
// provider's: the next sign-in may go straight through.
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.sessions.Clear(w)
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

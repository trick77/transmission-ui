package httpapi

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/trick77/transmission-ui/backend/internal/auth"
	"github.com/trick77/transmission-ui/backend/internal/config"
)

// The reverse proxy forwards the prefix rather than stripping it, so every
// route has to answer under it and every redirect has to stay inside it.
func prefixServer(t *testing.T) (*Server, *auth.SessionCodec) {
	t.Helper()
	srv, sessions := newTestServer(t, config.AuthModeForm, "media", nil)
	srv.cfg.BasePath = "/transmission"
	srv.cfg.RPCUser = "u"
	srv.cfg.RPCPass = "p"
	return srv, sessions
}

func TestPrefixServesRoutes(t *testing.T) {
	srv, sessions := prefixServer(t)
	cookie, _ := sessions.Encode(auth.Claims{Subject: "u1", Groups: []string{"media"}})

	for _, tc := range []struct {
		name, method, path string
		cookie             bool
		want               int
	}{
		{"login page", http.MethodGet, "/transmission/login", false, http.StatusOK},
		{"app shell", http.MethodGet, "/transmission/", true, http.StatusOK},
		{"rpc", http.MethodPost, "/transmission/transmission/rpc", true, http.StatusOK},
		{"rpc unauthenticated", http.MethodPost, "/transmission/transmission/rpc", false, http.StatusUnauthorized},
		{"me", http.MethodGet, "/transmission/api/auth/me", true, http.StatusOK},
		// Outside the prefix nothing is mounted.
		{"unprefixed login", http.MethodGet, "/login", false, http.StatusNotFound},
		{"unprefixed me", http.MethodGet, "/api/auth/me", true, http.StatusNotFound},
		// "/transmission/rpc" without the prefix collides with the prefixed
		// GET route's pattern, so the mux answers 405 rather than 404. Either
		// way the daemon is not reached.
		{"unprefixed rpc", http.MethodPost, "/transmission/rpc", true, http.StatusMethodNotAllowed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			if tc.cookie {
				req.AddCookie(cookie)
			}
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("%s %s: want %d, got %d", tc.method, tc.path, tc.want, rec.Code)
			}
		})
	}
}

// A redirect that drops the prefix leaves the proxy's route and 404s.
func TestPrefixRedirectsStayInside(t *testing.T) {
	srv, _ := prefixServer(t)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/transmission/", nil))
	if loc := rec.Header().Get("Location"); loc != "/transmission/login" {
		t.Fatalf("signed-out root: want /transmission/login, got %q", loc)
	}

	rec = httptest.NewRecorder()
	form := url.Values{"username": {"u"}, "password": {"p"}}
	req := httptest.NewRequest(http.MethodPost, "/transmission/login", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	srv.Handler().ServeHTTP(rec, req)
	if loc := rec.Header().Get("Location"); loc != "/transmission/" {
		t.Fatalf("after sign-in: want /transmission/, got %q", loc)
	}

	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/transmission/api/auth/logout", nil))
	if loc := rec.Header().Get("Location"); loc != "/transmission/login" {
		t.Fatalf("after logout: want /transmission/login, got %q", loc)
	}
}

// The login page's own asset and form URLs must carry the prefix.
func TestPrefixLoginPageURLs(t *testing.T) {
	srv, _ := prefixServer(t)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/transmission/login", nil))
	body := rec.Body.String()
	for _, want := range []string{
		`action="/transmission/login"`,
		`url("/transmission/login-assets/login-bg.webp")`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("login page missing %q", want)
		}
	}
}

// The app reads its mount point from this tag; without it the RPC URL is
// wrong under a prefix.
func TestPrefixInjectsBaseMeta(t *testing.T) {
	srv, sessions := prefixServer(t)
	cookie, _ := sessions.Encode(auth.Claims{Subject: "u1", Groups: []string{"media"}})
	req := httptest.NewRequest(http.MethodGet, "/transmission/", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), `<meta name="tmui-base" content="/transmission">`) {
		t.Fatalf("base meta not injected: %q", rec.Body.String())
	}
}

func TestPrefixServesLoginAssets(t *testing.T) {
	srv, _ := prefixServer(t)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/transmission/login-assets/login-bg.webp", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
}

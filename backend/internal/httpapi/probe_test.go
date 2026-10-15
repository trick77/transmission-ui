package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/trick77/ship/kit/auth"
	"github.com/trick77/ship/kit/httpx"
	"github.com/trick77/transmission-ui/backend/internal/config"
)

// Probes mount under the prefix like every route: the container healthcheck
// asks BasePath+"/healthz", and readiness runs the checks it was given.
func TestProbesUnderPrefix(t *testing.T) {
	cfg := config.Config{AuthMode: config.AuthModeForm, BasePath: "/transmission"}
	ui := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte(`<meta name="tmui-base" content="">`)}}
	down := errors.New("daemon down")
	var failing error
	srv, err := New(cfg, nil, newSessions(t, cfg).Sessions, http.NotFoundHandler(), ui, nil,
		httpx.Check{Name: "transmission", Run: func(context.Context) error { return failing }})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	for _, tc := range []struct {
		path string
		fail error
		want int
	}{
		{"/transmission/healthz", nil, http.StatusOK},
		{"/transmission/healthz", down, http.StatusOK},
		{"/transmission/readyz", nil, http.StatusOK},
		{"/transmission/readyz", down, http.StatusServiceUnavailable},
		{"/healthz", nil, http.StatusNotFound},
	} {
		failing = tc.fail
		if got := probe(srv, tc.path).Code; got != tc.want {
			t.Errorf("%s (check err %v): want %d, got %d", tc.path, tc.fail, tc.want, got)
		}
	}
}

// probe asks as the container healthcheck does: from loopback, no proxy
// headers. The kit's probes answer nobody else.
func probe(srv *Server, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.RemoteAddr = "127.0.0.1:40000"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

// Every answer carries the baseline headers, the login page and API errors
// alike, not only the shell.
func TestSecurityHeaders(t *testing.T) {
	srv, _ := newTestServer(t, config.AuthModeForm, "", nil)
	for _, path := range []string{"/login", "/transmission/rpc"} {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		h := rec.Header()
		if h.Get("Content-Security-Policy") != httpx.DefaultCSP || h.Get("X-Frame-Options") != "DENY" ||
			h.Get("X-Content-Type-Options") != "nosniff" || h.Get(httpx.RequestIDHeader) == "" {
			t.Errorf("%s: headers %v", path, h)
		}
	}
}

// A panicking handler answers a JSON 500 instead of dropping the connection.
func TestPanicRecovered(t *testing.T) {
	cfg := config.Config{AuthMode: config.AuthModeForm}
	ui := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte(`<meta name="tmui-base" content="">`)}}
	srv, err := New(cfg, nil, newSessions(t, cfg).Sessions, http.NotFoundHandler(), ui,
		slog.New(slog.DiscardHandler),
		httpx.Check{Name: "transmission", Run: func(context.Context) error { panic("boom") }})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	rec := probe(srv, "/readyz")
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"error"`) {
		t.Fatalf("want JSON 500, got %d %q", rec.Code, rec.Body.String())
	}
}

// API errors are {"error": "..."}, which the UI reads for its banner.
func TestAPIErrorsAreJSON(t *testing.T) {
	srv, _ := newTestServer(t, config.AuthModeOIDC, "media", &fakeOIDC{err: auth.ErrInvalidState})
	for _, tc := range []struct {
		method, path string
		want         int
		body         string
	}{
		{http.MethodPost, "/transmission/rpc", http.StatusUnauthorized, `{"error":"unauthorized"}`},
		{http.MethodGet, "/transmission/rpc", http.StatusMethodNotAllowed, `{"error":"method not allowed"}`},
		{http.MethodGet, "/api/auth/callback?code=x", http.StatusUnauthorized, `{"error":"authentication failed"}`},
		{http.MethodPost, "/login", http.StatusNotFound, `{"error":"not found"}`},
	} {
		wantJSONError(t, srv, tc.method, tc.path, tc.want, tc.body)
	}
	// Form mode has no provider: a stale callback bookmark is a JSON 404.
	form, _ := newTestServer(t, config.AuthModeForm, "", nil)
	wantJSONError(t, form, http.MethodGet, "/api/auth/callback?code=x", http.StatusNotFound, `{"error":"not found"}`)
}

func wantJSONError(t *testing.T, srv *Server, method, path string, want int, body string) {
	t.Helper()
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	if rec.Code != want || strings.TrimSpace(rec.Body.String()) != body ||
		!strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		t.Errorf("%s %s: want %d %s, got %d %q (%s)", method, path, want, body,
			rec.Code, rec.Body.String(), rec.Header().Get("Content-Type"))
	}
}

func TestOIDCConfigAndSessionsCarryPrefix(t *testing.T) {
	cfg := config.Config{BasePath: "/transmission", OIDCAllowedGroup: "media", SecureCookies: true}
	o := OIDCConfig(cfg)
	if o.CookiePrefix != "tmui_" || o.CookiePath != "/transmission/" || o.Group != "media" || !o.Secure {
		t.Fatalf("oidc config: %+v", o)
	}
	cookie, err := newSessions(t, cfg).Encode(auth.Claims{Subject: "u1"})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if cookie.Name != "tmui_session" || cookie.Path != "/transmission/" || !cookie.Secure {
		t.Fatalf("session cookie: %+v", cookie)
	}
	if _, err := NewSessions(config.Config{SessionKey: []byte("short")}); err == nil {
		t.Fatal("accepted a short key")
	}
}

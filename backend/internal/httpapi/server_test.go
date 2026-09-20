package httpapi

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/trick77/transmission-ui/backend/internal/auth"
	"github.com/trick77/transmission-ui/backend/internal/config"
)

type fakeOIDC struct {
	claims auth.Claims
	err    error
}

func (f *fakeOIDC) StartLogin(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "https://idp.example/authorize", http.StatusFound)
}
func (f *fakeOIDC) HandleCallback(*http.Request) (auth.Claims, error) { return f.claims, f.err }
func (f *fakeOIDC) ClearTransientCookies(http.ResponseWriter)         {}

func newTestServer(t *testing.T, mode config.AuthMode, group string, oidc OIDC) (*Server, *auth.SessionCodec) {
	t.Helper()
	cfg := config.Config{AuthMode: mode, OIDCAllowedGroup: group, SessionTTL: time.Hour}
	sessions := auth.NewSessionCodec("test-secret", false, time.Hour, group, "")
	rpc := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("reached-daemon"))
	})
	ui := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte(`<html><meta name="tmui-base" content="">ui</html>`)}}
	return New(cfg, oidc, sessions, rpc, ui, slog.New(slog.DiscardHandler)), sessions
}

// The bundle itself is privileged: serving it to an anonymous visitor renders the
// whole shell and leaks the layout, with only the RPC refusing. oidc mode answers
// the login card instead, and with 200, because the container healthcheck probes
// this route and counts >= 400 as unhealthy.
func TestAppShellHiddenWhenSignedOut(t *testing.T) {
	srv, _ := newTestServer(t, config.AuthModeOIDC, "media", &fakeOIDC{})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200 so the healthcheck stays green, got %d", rec.Code)
	}
	body := rec.Body.String()
	if strings.Contains(body, "tmui-base") {
		t.Fatal("served the app bundle to an anonymous visitor")
	}
	if !strings.Contains(body, "Continue to sign in") {
		t.Fatalf("want the form-less sign-in card, got %q", body)
	}
	if strings.Contains(body, "name=\"password\"") {
		t.Fatal("oidc mode must not render the credential form")
	}
}

// staticHandler rewrites every unknown extensionless path to index.html for the
// SPA's client-side routes, so gating only "/" leaves the shell reachable at
// /settings, /detail or any made-up path. Deep links are the regression this
// guards: an earlier version of the gate passed the "/" tests while leaking here.
func TestAppShellHiddenOnDeepLinks(t *testing.T) {
	srv, _ := newTestServer(t, config.AuthModeOIDC, "media", &fakeOIDC{})
	for _, path := range []string{"/", "/settings", "/detail", "/anything-at-all"} {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if strings.Contains(rec.Body.String(), "tmui-base") {
			t.Errorf("%s served the app bundle to an anonymous visitor", path)
		}
		if rec.Code != http.StatusOK {
			t.Errorf("%s: want 200 so the healthcheck stays green, got %d", path, rec.Code)
		}
	}
}

func TestAppShellDeepLinksRedirectInFormMode(t *testing.T) {
	srv, _ := newTestServer(t, config.AuthModeForm, "media", &fakeOIDC{})
	for _, path := range []string{"/", "/settings", "/anything-at-all"} {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusFound {
			t.Errorf("%s: want 302, got %d", path, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "tmui-base") {
			t.Errorf("%s served the app bundle to an anonymous visitor", path)
		}
	}
}

// A signed-in visitor still reaches the client-side routes.
func TestAppShellDeepLinkServedWithSession(t *testing.T) {
	srv, sessions := newTestServer(t, config.AuthModeOIDC, "media", &fakeOIDC{})
	cookie, err := sessions.Encode(auth.Claims{Subject: "u1", Groups: []string{"media"}})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/settings", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), "tmui-base") {
		t.Fatalf("signed-in deep link did not get the bundle: %d %q", rec.Code, rec.Body.String())
	}
}

// Form mode keeps its redirect to the page that has the form.
func TestAppShellRedirectsToFormLogin(t *testing.T) {
	srv, _ := newTestServer(t, config.AuthModeForm, "media", &fakeOIDC{})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusFound {
		t.Fatalf("want 302, got %d", rec.Code)
	}
	if got := rec.Header().Get("Location"); got != "/login" {
		t.Fatalf("want /login, got %q", got)
	}
}

// A valid session still gets the app.
func TestAppShellServedWithSession(t *testing.T) {
	srv, sessions := newTestServer(t, config.AuthModeOIDC, "media", &fakeOIDC{})
	cookie, err := sessions.Encode(auth.Claims{Subject: "u1", Groups: []string{"media"}})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "tmui-base") {
		t.Fatalf("signed-in request did not get the bundle: %d %q", rec.Code, rec.Body.String())
	}
}

// A session without the required group is not a pass for the shell either.
func TestAppShellHiddenWithoutGroup(t *testing.T) {
	srv, sessions := newTestServer(t, config.AuthModeOIDC, "media", &fakeOIDC{})
	cookie, err := sessions.Encode(auth.Claims{Subject: "u1", Groups: []string{"other"}})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if strings.Contains(rec.Body.String(), "tmui-base") {
		t.Fatal("a session outside the allowed group got the bundle")
	}
}

// The form POST exists in every mode now, so it has to refuse outside form mode.
func TestFormPostRejectedInOIDCMode(t *testing.T) {
	srv, _ := newTestServer(t, config.AuthModeOIDC, "media", &fakeOIDC{})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/login", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("want 404, got %d", rec.Code)
	}
}

// The proxy must be unreachable without a valid session.
func TestRPCRequiresSession(t *testing.T) {
	srv, _ := newTestServer(t, config.AuthModeOIDC, "media", &fakeOIDC{})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/transmission/rpc", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", rec.Code)
	}
	if rec.Body.String() == "reached-daemon" {
		t.Fatal("unauthenticated request reached the daemon")
	}
}

func TestRPCWithSessionReachesDaemon(t *testing.T) {
	srv, sessions := newTestServer(t, config.AuthModeOIDC, "media", &fakeOIDC{})
	cookie, err := sessions.Encode(auth.Claims{Subject: "u1", Groups: []string{"media"}})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/transmission/rpc", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != "reached-daemon" {
		t.Fatalf("authorized request blocked: %d %q", rec.Code, rec.Body.String())
	}
}

// A valid session for someone outside the allowed group is still refused.
func TestRPCRejectsWrongGroup(t *testing.T) {
	srv, sessions := newTestServer(t, config.AuthModeOIDC, "media", &fakeOIDC{})
	cookie, _ := sessions.Encode(auth.Claims{Subject: "u2", Groups: []string{"Other"}})
	req := httptest.NewRequest(http.MethodPost, "/transmission/rpc", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("want 403, got %d", rec.Code)
	}
}

func TestCallbackRejectsWrongGroup(t *testing.T) {
	srv, _ := newTestServer(t, config.AuthModeOIDC, "media",
		&fakeOIDC{claims: auth.Claims{Subject: "u3", Groups: []string{"Nope"}}})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/auth/callback?code=x", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("want 403, got %d", rec.Code)
	}
	if len(rec.Result().Cookies()) > 0 && rec.Result().Cookies()[0].Value != "" {
		t.Fatal("session issued to a user outside the group")
	}
}

func TestCallbackIssuesSession(t *testing.T) {
	srv, sessions := newTestServer(t, config.AuthModeOIDC, "media",
		&fakeOIDC{claims: auth.Claims{Subject: "u1", Groups: []string{"media"}}})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/auth/callback?code=x", nil))
	if rec.Code != http.StatusFound {
		t.Fatalf("want redirect, got %d", rec.Code)
	}
	var session *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == auth.SessionCookieName {
			session = c
		}
	}
	if session == nil {
		t.Fatal("no session cookie issued")
	}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(session)
	if _, err := sessions.Decode(req); err != nil {
		t.Fatalf("issued cookie does not verify: %v", err)
	}
}

// A GET on the RPC path must not fall through to the SPA handler.
func TestRPCPathRejectsNonPost(t *testing.T) {
	srv, _ := newTestServer(t, config.AuthModeOIDC, "media", &fakeOIDC{})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/transmission/rpc", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("want 405, got %d", rec.Code)
	}
	if rec.Header().Get("Allow") != "POST" {
		t.Fatalf("missing Allow header: %q", rec.Header().Get("Allow"))
	}
}

// /api/auth/me must apply the same group check as the RPC guard, or a revoked
// user still reads as signed in while every RPC call returns 403.
func TestMeRejectsWrongGroup(t *testing.T) {
	srv, sessions := newTestServer(t, config.AuthModeOIDC, "media", &fakeOIDC{})
	cookie, _ := sessions.Encode(auth.Claims{Subject: "u1", Groups: []string{"Other"}})
	req := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("want 403, got %d", rec.Code)
	}
}

func TestStaticFallsBackToIndex(t *testing.T) {
	srv, sessions := newTestServer(t, config.AuthModeOIDC, "media", &fakeOIDC{})
	// The shell is gated, so this needs a session: without one the fallback is
	// correct but answers the sign-in card, and this test is about routing.
	cookie, err := sessions.Encode(auth.Claims{Subject: "u1", Groups: []string{"media"}})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/some/spa/route", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	body, _ := io.ReadAll(rec.Body)
	if rec.Code != http.StatusOK || !strings.Contains(string(body), "ui</html>") {
		t.Fatalf("spa fallback failed: %d %q", rec.Code, body)
	}
}

// No favicon.ico ships: the app declares an SVG icon, and the clients that
// still probe this path are RSS readers, Windows bookmark thumbnails and old
// IE. It must 404 rather than fall back to index.html, or those clients get
// HTML where they expect an image. isAssetRequest already covers it — anything
// with an extension is an asset — so this is a regression guard on that rule,
// not on a route of its own.
func TestFaviconIcoIsNotFound(t *testing.T) {
	srv, _ := newTestServer(t, config.AuthModeOIDC, "Arr", &fakeOIDC{})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/favicon.ico", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("want 404 for /favicon.ico, got %d", rec.Code)
	}
}

// The icon the app DOES ship must be served, not 404'd: it is a real file in
// the bundle, and the tab icon is the one asset every page load fetches.
func TestIconSvgIsServed(t *testing.T) {
	cfg := config.Config{AuthMode: config.AuthModeOIDC, SessionTTL: time.Hour}
	ui := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>ui</html>")},
		"icon.svg":   &fstest.MapFile{Data: []byte("<svg/>")},
	}
	srv := New(cfg, &fakeOIDC{},
		auth.NewSessionCodec("test-secret", false, time.Hour, "", ""),
		http.NotFoundHandler(), ui, slog.New(slog.DiscardHandler))
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/icon.svg", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "<svg/>" {
		t.Fatalf("icon.svg not served: %d %q", rec.Code, rec.Body.String())
	}
}

// Go's mime table has no .webmanifest entry, so without an explicit
// Content-Type net/http sniffs the JSON and serves text/plain, which Chrome
// refuses -- the app stops being installable and nothing else surfaces it.
func TestWebmanifestContentType(t *testing.T) {
	cfg := config.Config{AuthMode: config.AuthModeOIDC, SessionTTL: time.Hour}
	ui := fstest.MapFS{
		"index.html":       &fstest.MapFile{Data: []byte("<html>ui</html>")},
		"site.webmanifest": &fstest.MapFile{Data: []byte(`{"name":"transmission-ui"}`)},
	}
	srv := New(cfg, &fakeOIDC{},
		auth.NewSessionCodec("test-secret", false, time.Hour, "", ""),
		http.NotFoundHandler(), ui, slog.New(slog.DiscardHandler))
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/site.webmanifest", nil))
	if got := rec.Header().Get("Content-Type"); got != "application/manifest+json" {
		t.Fatalf("want application/manifest+json, got %q", got)
	}
}

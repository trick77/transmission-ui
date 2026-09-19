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
	srv, _ := newTestServer(t, config.AuthModeOIDC, "media", &fakeOIDC{})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/some/spa/route", nil))
	body, _ := io.ReadAll(rec.Body)
	if rec.Code != http.StatusOK || !strings.Contains(string(body), "ui</html>") {
		t.Fatalf("spa fallback failed: %d %q", rec.Code, body)
	}
}

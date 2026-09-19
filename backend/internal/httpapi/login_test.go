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

func formServer(t *testing.T) (*Server, *auth.SessionCodec) {
	t.Helper()
	srv, sessions := newTestServer(t, config.AuthModeForm, "Arr", nil)
	srv.cfg.RPCUser = "daemonuser"
	srv.cfg.RPCPass = "daemonpass"
	return srv, sessions
}

func post(form url.Values) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/login", strings.NewReader(form.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return r
}

func TestFormLoginPageRenders(t *testing.T) {
	srv, _ := formServer(t)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/login", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `name="password"`) {
		t.Fatal("no password field on the login page")
	}
}

func TestFormLoginAcceptsDaemonCredentials(t *testing.T) {
	srv, sessions := formServer(t)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, post(url.Values{"username": {"daemonuser"}, "password": {"daemonpass"}}))
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
		t.Fatal("no session issued")
	}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(session)
	claims, err := sessions.Decode(req)
	if err != nil {
		t.Fatalf("issued cookie does not verify: %v", err)
	}
	// The session must satisfy the same group check the RPC guard applies.
	if !claims.HasGroup("Arr") {
		t.Fatal("form session would be refused by requireAuth")
	}
}

func TestFormLoginRejectsBadCredentials(t *testing.T) {
	for _, tc := range []struct{ name, user, pass string }{
		{"wrong password", "daemonuser", "nope"},
		{"wrong username", "nobody", "daemonpass"},
		{"both empty", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, _ := formServer(t)
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, post(url.Values{"username": {tc.user}, "password": {tc.pass}}))
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("want 401, got %d", rec.Code)
			}
			for _, c := range rec.Result().Cookies() {
				if c.Name == auth.SessionCookieName && c.Value != "" {
					t.Fatal("session issued for bad credentials")
				}
			}
		})
	}
}

// The RPC guard must not care which mode issued the session.
func TestFormSessionReachesDaemon(t *testing.T) {
	srv, _ := formServer(t)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, post(url.Values{"username": {"daemonuser"}, "password": {"daemonpass"}}))
	var session *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == auth.SessionCookieName {
			session = c
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/transmission/rpc", nil)
	req.AddCookie(session)
	rec2 := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec2, req)
	if rec2.Body.String() != "reached-daemon" {
		t.Fatalf("form session blocked from rpc: %d %q", rec2.Code, rec2.Body.String())
	}
}

// An unauthenticated visitor lands on the form, not on the app shell.
func TestFormModeRedirectsRootToLogin(t *testing.T) {
	srv, _ := formServer(t)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/login" {
		t.Fatalf("want redirect to /login, got %d %q", rec.Code, rec.Header().Get("Location"))
	}
}

// /login must not exist in oidc mode, where the IdP owns the credentials.
func TestLoginPageAbsentInOIDCMode(t *testing.T) {
	srv, _ := newTestServer(t, config.AuthModeOIDC, "Arr", &fakeOIDC{})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/login", nil))
	if rec.Code == http.StatusOK && strings.Contains(rec.Body.String(), `name="password"`) {
		t.Fatal("login form served in oidc mode")
	}
}

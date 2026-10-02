package httpapi

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/trick77/transmission-ui/backend/internal/auth"
	"github.com/trick77/transmission-ui/backend/internal/config"
)

func get(srv *Server, path string, cookie *http.Cookie, header ...string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

// The embedded bundle has no modification times, so the shell needs an ETag or
// every revalidation transfers it whole.
func TestShellRevalidatesWith304(t *testing.T) {
	srv, sessions := newTestServer(t, config.AuthModeOIDC, "", &fakeOIDC{})
	cookie, _ := sessions.Encode(auth.Claims{Subject: "u1"})
	first := get(srv, "/", cookie)
	tag := first.Header().Get("ETag")
	if first.Code != http.StatusOK || tag == "" || first.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("want 200 with an ETag and no-cache, got %d %q %q", first.Code, tag, first.Header().Get("Cache-Control"))
	}
	if again := get(srv, "/", cookie, "If-None-Match", tag); again.Code != http.StatusNotModified {
		t.Fatalf("want 304 for a matching validator, got %d", again.Code)
	}
	// A validator must not open the shell to someone who is signed out.
	if anon := get(srv, "/", nil, "If-None-Match", tag); anon.Code != http.StatusOK || !strings.Contains(anon.Body.String(), "Sign in") {
		t.Fatalf("signed out with a validator: want the sign-in card, got %d", anon.Code)
	}
}

func TestHashedAssetsAreImmutable(t *testing.T) {
	cfg := config.Config{AuthMode: config.AuthModeOIDC, SessionTTL: time.Hour}
	ui := fstest.MapFS{
		"index.html":           &fstest.MapFile{Data: []byte("<html>ui</html>")},
		"assets/index-abc1.js": &fstest.MapFile{Data: []byte("console.log(1)")},
		"icon.svg":             &fstest.MapFile{Data: []byte("<svg/>")},
	}
	srv := mustNew(t, cfg, &fakeOIDC{}, auth.NewSessionCodec("test-secret", false, time.Hour, "", ""), http.NotFoundHandler(), ui)
	asset := get(srv, "/assets/index-abc1.js", nil)
	if asset.Code != http.StatusOK || asset.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("hashed asset: got %d %q", asset.Code, asset.Header().Get("Cache-Control"))
	}
	// Outside assets/ the name is not versioned, so it must not be pinned.
	if cc := get(srv, "/icon.svg", nil).Header().Get("Cache-Control"); strings.Contains(cc, "immutable") {
		t.Fatalf("unversioned file marked immutable: %q", cc)
	}
}

// Login assets keep their names across releases, so they revalidate instead of
// being pinned for a year.
func TestLoginAssetsRevalidate(t *testing.T) {
	srv, _ := formServer(t)
	first := get(srv, "/login-assets/icon.svg", nil)
	tag := first.Header().Get("ETag")
	if first.Code != http.StatusOK || tag == "" || first.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("want 200 with an ETag and no-cache, got %d %q %q", first.Code, tag, first.Header().Get("Cache-Control"))
	}
	if again := get(srv, "/login-assets/icon.svg", nil, "If-None-Match", tag); again.Code != http.StatusNotModified {
		t.Fatalf("want 304, got %d", again.Code)
	}
}

func TestNewRefusesBundleWithoutBaseTag(t *testing.T) {
	cfg := config.Config{AuthMode: config.AuthModeForm, BasePath: "/transmission"}
	ui := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>ui</html>")}}
	if _, err := New(cfg, nil, auth.NewSessionCodec("s", false, time.Hour, "", ""), http.NotFoundHandler(), ui, nil); err == nil {
		t.Fatal("want an error: the UI could not be told its base path")
	}
	if _, err := New(config.Config{}, nil, nil, nil, fstest.MapFS{}, nil); err == nil {
		t.Fatal("want an error for a bundle with no index.html")
	}
}

// A session the shell refuses must not be sent back to the shell by /login, or
// the two redirect to each other forever.
func TestLoginPageDoesNotBounceARefusedSession(t *testing.T) {
	srv, sessions := newTestServer(t, config.AuthModeForm, "media", nil)
	cookie, _ := sessions.Encode(auth.Claims{Subject: "u1", Groups: []string{"other"}})
	if shell := get(srv, "/", cookie); shell.Header().Get("Location") != "/login" {
		t.Fatalf("shell: want a redirect to /login, got %d %q", shell.Code, shell.Header().Get("Location"))
	}
	if page := get(srv, "/login", cookie); page.Code != http.StatusOK {
		t.Fatalf("login page: want 200, got %d to %q", page.Code, page.Header().Get("Location"))
	}
}

func TestFormLoginCoolsDownAfterAFailure(t *testing.T) {
	srv, _ := formServer(t)
	try := func(pass string) int {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, post(url.Values{"username": {"daemonuser"}, "password": {pass}}))
		return rec.Code
	}
	if got := try("nope"); got != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", got)
	}
	// Even the right password is turned away unjudged inside the window.
	if got := try("daemonpass"); got != http.StatusTooManyRequests {
		t.Fatalf("want 429 during the cooldown, got %d", got)
	}
	time.Sleep(loginCooldown + 50*time.Millisecond)
	if got := try("daemonpass"); got != http.StatusFound {
		t.Fatalf("want a sign-in after the cooldown, got %d", got)
	}
}

func TestCrossSitePostsAreRefused(t *testing.T) {
	srv, sessions := formServer(t)
	cookie, _ := sessions.Encode(auth.Claims{Subject: "u1"})

	rpc := httptest.NewRequest(http.MethodPost, "/transmission/rpc", nil)
	rpc.AddCookie(cookie)
	rpc.Header.Set("Sec-Fetch-Site", "cross-site")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, rpc)
	if rec.Code != http.StatusForbidden || rec.Body.String() == "reached-daemon" {
		t.Fatalf("cross-site rpc: want 403, got %d %q", rec.Code, rec.Body.String())
	}

	login := post(url.Values{"username": {"daemonuser"}, "password": {"daemonpass"}})
	login.Header.Set("Origin", "https://evil.example")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, login)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("cross-origin login: want 403, got %d", rec.Code)
	}

	same := httptest.NewRequest(http.MethodPost, "/transmission/rpc", nil)
	same.AddCookie(cookie)
	same.Header.Set("Sec-Fetch-Site", "same-origin")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, same)
	if rec.Body.String() != "reached-daemon" {
		t.Fatalf("same-origin rpc blocked: %d %q", rec.Code, rec.Body.String())
	}
}

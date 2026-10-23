package httpapi

import (
	"context"
	"io/fs"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/trick77/ship/kit/auth"
	"github.com/trick77/ship/kit/ratelimit"
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
	srv := mustNew(t, cfg, &fakeOIDC{}, newSessions(t, cfg), http.NotFoundHandler(), ui)
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

// nosniff is set on every response, so a wrong Content-Type is not corrected
// by the browser: a font served as anything but font/woff2 leaves the page on
// its fallback faces. Ranges must keep working on the bodies opened per request.
func TestLoginAssetsServeTypesAndRanges(t *testing.T) {
	srv, _ := formServer(t)
	want := map[string]string{
		"icon.svg":                           "image/svg+xml",
		"login-bg.webp":                      "image/webp",
		"SansWebVariable-TextRegular.woff2":  "font/woff2",
		"SerifWebVariable-TextRegular.woff2": "font/woff2",
	}
	entries, err := fs.ReadDir(loginAssets, "assets")
	if err != nil || len(entries) != len(want) {
		t.Fatalf("want %d embedded assets, got %d: %v", len(want), len(entries), err)
	}
	for _, e := range entries {
		ctype, ok := want[e.Name()]
		if !ok {
			t.Fatalf("%s: no expected Content-Type", e.Name())
		}
		body, err := fs.ReadFile(loginAssets, "assets/"+e.Name())
		if err != nil {
			t.Fatal(err)
		}
		path := "/login-assets/" + e.Name()
		full := get(srv, path, nil)
		if full.Code != http.StatusOK || full.Header().Get("Content-Type") != ctype || full.Body.Len() != len(body) {
			t.Fatalf("%s: want 200 %s with %d bytes, got %d %q %d", path, ctype, len(body), full.Code,
				full.Header().Get("Content-Type"), full.Body.Len())
		}
		part := get(srv, path, nil, "Range", "bytes=2-9")
		wantRange := "bytes 2-9/" + strconv.Itoa(len(body))
		if part.Code != http.StatusPartialContent || part.Header().Get("Content-Range") != wantRange ||
			part.Body.String() != string(body[2:10]) {
			t.Fatalf("%s: want 206 %q, got %d %q", path, wantRange, part.Code, part.Header().Get("Content-Range"))
		}
	}
}

// The assets are served before sign-in, so nothing but the embedded files may
// resolve: a directory must not answer with a listing of them.
func TestLoginAssetsDirectoryIsNotListed(t *testing.T) {
	srv, _ := formServer(t)
	assertNoLoginAssetListing(t, srv, "")
}

func assertNoLoginAssetListing(t *testing.T, srv *Server, base string) {
	t.Helper()
	entries, err := fs.ReadDir(loginAssets, "assets")
	if err != nil || len(entries) == 0 {
		t.Fatalf("no embedded assets to check against: %v", err)
	}
	for _, path := range []string{"/login-assets/", "/login-assets/icon.svg/", "/login-assets/index.html"} {
		rec := get(srv, base+path, nil)
		if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"error"`) {
			t.Fatalf("%s: want a JSON 404, got %d %q", base+path, rec.Code, rec.Body.String())
		}
		for _, e := range entries {
			if strings.Contains(rec.Body.String(), e.Name()) {
				t.Fatalf("%s: body names %s: %q", base+path, e.Name(), rec.Body.String())
			}
		}
	}
}

func TestNewRefusesBundleWithoutBaseTag(t *testing.T) {
	cfg := config.Config{AuthMode: config.AuthModeForm, BasePath: "/transmission"}
	ui := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>ui</html>")}}
	if _, err := New(cfg, nil, newSessions(t, cfg).Sessions, http.NotFoundHandler(), ui, nil); err == nil {
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

// Parallel connections from one client must not multiply the guessing rate:
// its attempts are judged a penalty apart, not side by side.
func TestFormLoginSpacesOneClientsAttempts(t *testing.T) {
	srv, _ := formServer(t)
	const gap = 100 * time.Millisecond
	srv.throttle = ratelimit.NewThrottle(gap, loginMaxWait)
	try := func(pass string) int {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, post(url.Values{"username": {"daemonuser"}, "password": {pass}}))
		return rec.Code
	}
	const guesses = 4
	start := time.Now()
	codes := make(chan int, guesses)
	for range guesses {
		go func() { codes <- try("nope") }()
	}
	for range guesses {
		if got := <-codes; got != http.StatusUnauthorized {
			t.Fatalf("want 401, got %d", got)
		}
	}
	// The first is judged at once, each further one a penalty later.
	if took, want := time.Since(start), (guesses-1)*gap; took < want {
		t.Fatalf("%d parallel guesses took %v, want at least %v", guesses, took, want)
	}
	// A correct attempt right after is judged, not turned away.
	if got := try("daemonpass"); got != http.StatusFound {
		t.Fatalf("want a sign-in, got %d", got)
	}
}

// One address flooding the form is refused past its own queue, and must not
// keep anybody else from signing in.
func TestFormLoginFloodDoesNotLockOthersOut(t *testing.T) {
	srv, _ := formServer(t)
	from := func(client, pass string) *http.Request {
		r := post(url.Values{"username": {"daemonuser"}, "password": {pass}})
		r.Header.Set("X-Forwarded-For", "203.0.113.9, "+client)
		return r
	}
	const flood = 40 // far past loginMaxWait / loginGap
	codes := make(chan int, flood)
	for range flood {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			defer cancel()
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, from("198.51.100.7", "nope").WithContext(ctx))
			codes <- rec.Code
		}()
	}
	refused := 0
	for range flood {
		if <-codes == http.StatusTooManyRequests {
			refused++
		}
	}
	if refused == 0 {
		t.Fatal("a flood from one address was all queued, none refused")
	}

	start := time.Now()
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, from("198.51.100.8", "daemonpass"))
	if rec.Code != http.StatusFound || time.Since(start) > loginGap/2 {
		t.Fatalf("another client during the flood: want a prompt sign-in, got %d after %v", rec.Code, time.Since(start))
	}
}

// formTry posts a wrong password from client, as the proxy forwards it.
func formTry(srv *Server, client string) *httptest.ResponseRecorder {
	r := post(url.Values{"username": {"daemonuser"}, "password": {"nope"}})
	r.Header.Set("X-Forwarded-For", client)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, r)
	return rec
}

// A refusal's Retry-After is the throttle's wait, rounded up to whole seconds
// by kit, and the answer is still the sign-in page rather than a bare error.
func TestFormLoginRefusalCarriesTheRealWait(t *testing.T) {
	srv, _ := formServer(t)
	// The first attempt books the next turn 7.99s out, 2.99s past the 5s
	// queue: the second is refused for 2.99s less the time between them,
	// "3" rounded up on any runner that takes under 0.99s for the two.
	const wait = 2990 * time.Millisecond
	srv.throttle = ratelimit.NewThrottle(5*time.Second+wait, 5*time.Second)
	start := time.Now()
	if rec := formTry(srv, "198.51.100.7"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("first attempt: want 401, got %d", rec.Code)
	}
	rec := formTry(srv, "198.51.100.7")
	// A slower runner shrinks the wait: the header is then the remainder
	// rounded up, between what is left now and 3.
	least := max(int(math.Ceil((wait - time.Since(start)).Seconds())), 1)
	got, err := strconv.Atoi(rec.Header().Get("Retry-After"))
	if rec.Code != http.StatusTooManyRequests || err != nil || got < least || got > 3 {
		t.Fatalf("want 429 with Retry-After in [%d, 3], got %d %q", least, rec.Code, rec.Header().Get("Retry-After"))
	}
	if !strings.Contains(rec.Body.String(), "Too many attempts") {
		t.Fatalf("want the sign-in page with the error, got %q", rec.Body.String())
	}
}

// Rotating the low 64 bits of an IPv6 address is free, so one /64 shares a
// turn; the next /64 over is somebody else.
func TestFormLoginThrottlesIPv6ByItsSlash64(t *testing.T) {
	srv, _ := formServer(t)
	srv.throttle = ratelimit.NewThrottle(time.Minute, loginMaxWait)
	if rec := formTry(srv, "2001:db8:1:2::1"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("first attempt: want 401, got %d", rec.Code)
	}
	if rec := formTry(srv, "2001:db8:1:2::ffff"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("same /64: want 429, got %d", rec.Code)
	}
	if rec := formTry(srv, "2001:db8:1:3::1"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("next /64: want 401, got %d", rec.Code)
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

package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The daemon must receive our credentials, and the browser's own Authorization
// or Cookie headers must never reach it.
func TestProxyInjectsBasicAuthAndStripsClientCredentials(t *testing.T) {
	var gotUser, gotPass string
	var gotAuthOK bool
	var gotCookie, gotSessionID, gotPath string

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUser, gotPass, gotAuthOK = r.BasicAuth()
		gotCookie = r.Header.Get("Cookie")
		gotSessionID = r.Header.Get("X-Transmission-Session-Id")
		gotPath = r.URL.Path
		w.Header().Set("X-Transmission-Session-Id", "fresh-session-id")
		w.WriteHeader(http.StatusConflict)
	}))
	defer upstream.Close()

	h, err := New(Config{Upstream: upstream.URL, User: "daemon", Pass: "secret"})
	if err != nil {
		t.Fatalf("new: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/transmission/rpc", strings.NewReader(`{}`))
	req.SetBasicAuth("attacker", "hunter2")
	req.AddCookie(&http.Cookie{Name: "tmui_session", Value: "should-not-be-forwarded"})
	req.Header.Set("X-Transmission-Session-Id", "client-session-id")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if !gotAuthOK || gotUser != "daemon" || gotPass != "secret" {
		t.Fatalf("daemon got wrong credentials: ok=%v user=%q", gotAuthOK, gotUser)
	}
	if gotCookie != "" {
		t.Fatalf("session cookie leaked upstream: %q", gotCookie)
	}
	if gotPath != "/transmission/rpc" {
		t.Fatalf("wrong upstream path: %q", gotPath)
	}
	// The 409 handshake has to survive in both directions.
	if gotSessionID != "client-session-id" {
		t.Fatalf("session id not forwarded upstream: %q", gotSessionID)
	}
	if rec.Code != http.StatusConflict {
		t.Fatalf("status not passed through: %d", rec.Code)
	}
	if rec.Header().Get("X-Transmission-Session-Id") != "fresh-session-id" {
		t.Fatal("session id not returned to the client")
	}
}

func TestProxyPassesBodyAndResponse(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"method":"session-get"}` {
			t.Errorf("body not forwarded: %q", body)
		}
		_, _ = w.Write([]byte(`{"result":"success"}`))
	}))
	defer upstream.Close()

	h, err := New(Config{Upstream: upstream.URL, User: "u", Pass: "p"})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/transmission/rpc", strings.NewReader(`{"method":"session-get"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if got := rec.Body.String(); got != `{"result":"success"}` {
		t.Fatalf("response not passed through: %q", got)
	}
}

func TestProxyRejectsBadUpstream(t *testing.T) {
	for _, upstream := range []string{"", "not a url", "/relative"} {
		if _, err := New(Config{Upstream: upstream, User: "u"}); err == nil {
			t.Fatalf("accepted bad upstream %q", upstream)
		}
	}
}

// An unreachable daemon is a 502, not a panic.
func TestProxyUpstreamDown(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := down.URL
	down.Close()

	h, err := New(Config{Upstream: url, User: "u", Pass: "p"})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/transmission/rpc", nil))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("want 502, got %d", rec.Code)
	}
}

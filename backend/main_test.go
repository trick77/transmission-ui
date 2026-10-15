package main

import (
	"context"
	"errors"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The container healthcheck probes the liveness route under the app's own
// mount point: 2xx only (a redirect means the probe is misrouted), and no
// listener at all is unhealthy too.
func TestHealthcheck(t *testing.T) {
	cases := []struct {
		name      string
		publicURL string
		path      string
		status    int
		want      int
	}{
		{"ok", "", "/healthz", http.StatusOK, 0},
		{"redirect is misrouted", "", "/healthz", http.StatusFound, 1},
		{"not mounted here", "", "/healthz", http.StatusNotFound, 1},
		{"under a base path", "https://seedbox.example.com/transmission", "/transmission/healthz", http.StatusOK, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotPath string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotPath = r.URL.Path
				if tc.status == http.StatusFound {
					http.Redirect(w, r, "/login", tc.status)
					return
				}
				w.WriteHeader(tc.status)
			}))
			defer srv.Close()
			// ":port", as BACKEND_ADDR is usually written: probed on loopback.
			_, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
			t.Setenv("BACKEND_ADDR", ":"+port)
			t.Setenv("BACKEND_PUBLIC_URL", tc.publicURL)

			if got := healthcheck(); got != tc.want {
				t.Fatalf("healthcheck() = %d, want %d", got, tc.want)
			}
			if gotPath != tc.path {
				t.Fatalf("probed %q, want %q", gotPath, tc.path)
			}
		})
	}
}

// Port 0 never accepts a connection; a closed httptest port could be rebound by
// a parallel test.
func TestHealthcheckNoListener(t *testing.T) {
	t.Setenv("BACKEND_ADDR", ":0")
	t.Setenv("BACKEND_PUBLIC_URL", "")

	if got := healthcheck(); got != 1 {
		t.Fatalf("healthcheck() = %d, want 1", got)
	}
}

// A bad LOG_LEVEL stops the start instead of logging at a silent default.
func TestRunRejectsUnknownLogLevel(t *testing.T) {
	t.Setenv("LOG_LEVEL", "verbose")
	if err := run(t.Context()); err == nil {
		t.Fatal("want an error for LOG_LEVEL=verbose")
	}
}

// A bad LOG_LEVEL does not hide the config faults: one start lists them all.
func TestRunJoinsLogLevelAndConfigFaults(t *testing.T) {
	t.Setenv("LOG_LEVEL", "verbose")
	t.Setenv("BACKEND_PUBLIC_URL", "")
	t.Setenv("BACKEND_AUTH_MODE", "form")
	err := run(t.Context())
	if err == nil || !strings.Contains(err.Error(), "verbose") || !strings.Contains(err.Error(), "BACKEND_PUBLIC_URL") {
		t.Fatalf("want the LOG_LEVEL and BACKEND_PUBLIC_URL faults together, got %v", err)
	}
}

// Config faults surface from run, all at once.
func TestRunRejectsBadConfig(t *testing.T) {
	t.Setenv("LOG_LEVEL", "error")
	t.Setenv("BACKEND_PUBLIC_URL", "")
	t.Setenv("BACKEND_AUTH_MODE", "form")
	if err := run(t.Context()); err == nil {
		t.Fatal("want a config error")
	}
}

// Shutdown during OIDC discovery ends the start at once, not after the 30s
// discovery timeout.
func TestRunStopsDuringDiscovery(t *testing.T) {
	idp := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer idp.Close()
	t.Setenv("LOG_LEVEL", "error")
	t.Setenv("BACKEND_PUBLIC_URL", "http://127.0.0.1:8080")
	t.Setenv("BACKEND_AUTH_MODE", "oidc")
	t.Setenv("BACKEND_SESSION_SECRET", strings.Repeat("s", 32))
	t.Setenv("BACKEND_OIDC_ISSUER", idp.URL)
	t.Setenv("BACKEND_OIDC_CLIENT_ID", "tmui")
	t.Setenv("BACKEND_OIDC_CLIENT_SECRET", "secret")
	t.Setenv("BACKEND_OIDC_REDIRECT_URL", "http://127.0.0.1:8080/api/auth/callback")
	t.Setenv("TRANSMISSION_USER", "user")

	ctx, cancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	if err := run(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want the context's end, got %v", err)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("run took %v after the context ended", d)
	}
}

// A shutdown before the listener is up is a clean stop. Needs the built UI
// (make fe-build), which the gate builds before the tests.
func TestRunStopsCleanly(t *testing.T) {
	if _, err := fs.Stat(distFS, "dist/index.html"); err != nil {
		t.Skip("no UI bundle in dist: make fe-build")
	}
	t.Setenv("LOG_LEVEL", "error")
	t.Setenv("BACKEND_ADDR", "127.0.0.1:0")
	t.Setenv("BACKEND_PUBLIC_URL", "http://127.0.0.1:8080")
	t.Setenv("BACKEND_AUTH_MODE", "form")
	t.Setenv("TRANSMISSION_USER", "user")
	t.Setenv("TRANSMISSION_PASSWORD", "pass")

	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := run(ctx); err != nil {
		t.Fatalf("run: %v", err)
	}
}

package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
	if err := run(); err == nil {
		t.Fatal("want an error for LOG_LEVEL=verbose")
	}
}

// A bad LOG_LEVEL does not hide the config faults: one start lists them all.
func TestRunJoinsLogLevelAndConfigFaults(t *testing.T) {
	t.Setenv("LOG_LEVEL", "verbose")
	t.Setenv("BACKEND_PUBLIC_URL", "")
	t.Setenv("BACKEND_AUTH_MODE", "form")
	err := run()
	if err == nil || !strings.Contains(err.Error(), "verbose") || !strings.Contains(err.Error(), "BACKEND_PUBLIC_URL") {
		t.Fatalf("want the LOG_LEVEL and BACKEND_PUBLIC_URL faults together, got %v", err)
	}
}

// Config faults surface from run, all at once.
func TestRunRejectsBadConfig(t *testing.T) {
	t.Setenv("LOG_LEVEL", "error")
	t.Setenv("BACKEND_PUBLIC_URL", "")
	t.Setenv("BACKEND_AUTH_MODE", "form")
	if err := run(); err == nil {
		t.Fatal("want a config error")
	}
}

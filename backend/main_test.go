package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The container healthcheck probes the app's own mount point: 2xx and 3xx are
// healthy (signed-out form mode redirects to /login), a 4xx is the misrouting
// the probe exists to catch, and no listener at all is unhealthy too.
func TestHealthcheck(t *testing.T) {
	cases := []struct {
		name      string
		publicURL string
		path      string
		status    int
		want      int
	}{
		{"ok", "", "/", http.StatusOK, 0},
		{"redirect to login", "", "/", http.StatusFound, 0},
		{"not mounted here", "", "/", http.StatusNotFound, 1},
		{"under a base path", "https://seedbox.example.com/transmission", "/transmission/", http.StatusOK, 0},
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

func TestHealthcheckNoListener(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	addr := srv.Listener.Addr().String()
	srv.Close()
	t.Setenv("BACKEND_ADDR", addr)
	t.Setenv("BACKEND_PUBLIC_URL", "")

	if got := healthcheck(); got != 1 {
		t.Fatalf("healthcheck() = %d, want 1", got)
	}
}

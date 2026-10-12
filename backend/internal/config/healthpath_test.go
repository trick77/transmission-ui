package config

import "testing"

// The container healthcheck probes BasePath+"/healthz". If BasePath were
// dropped the probe would miss the prefixed mount and report a healthy
// container as down.
func TestBasePathDrivesHealthProbe(t *testing.T) {
	for _, tc := range []struct{ publicURL, want string }{
		{"https://host.example/transmission", "/transmission"},
		{"https://host.example/transmission/", "/transmission"},
		{"https://host.example", ""},
		{"https://host.example/", ""},
		{"", ""},
	} {
		if got := BasePathOf(tc.publicURL); got != tc.want {
			t.Errorf("BasePathOf(%q) = %q, want %q", tc.publicURL, got, tc.want)
		}
	}
}

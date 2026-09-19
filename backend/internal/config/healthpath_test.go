package config

import "testing"

// The container healthcheck probes BasePath+"/". If BasePath were dropped the
// probe would hit "/", which serves nothing under a prefix, and the reverse
// proxy would drop a perfectly healthy container from its routing table.
func TestBasePathDrivesHealthProbe(t *testing.T) {
	for _, tc := range []struct{ publicURL, want string }{
		{"https://host.example/transmission", "/transmission"},
		{"https://host.example/transmission/", "/transmission"},
		{"https://host.example", ""},
		{"https://host.example/", ""},
		{"", ""},
	} {
		if got := basePathOf(tc.publicURL); got != tc.want {
			t.Errorf("basePathOf(%q) = %q, want %q", tc.publicURL, got, tc.want)
		}
	}
}

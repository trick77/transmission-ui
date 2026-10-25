package config

import "testing"

// The container healthcheck probes BasePath+"/healthz" and reads the base path
// without a full Load: ValidBasePath is the check both share.
func TestValidBasePath(t *testing.T) {
	for _, tc := range []struct {
		path string
		want bool
	}{
		{"", true},
		{"/transmission", true},
		{"/apps/transmission", true},
		{"transmission", false},
		{"/transmission/", false},
		{"/", false},
		{"//transmission", false},
		{"/transmission?x", false},
		{"/transmission#x", false},
		{"/trans mission", false},
		{"/a-b_c.d~e/f", true},
		{"/{name}", false},
		{"/{name...}", false},
		{"/a%2Fb", false},
		{"/a;b", false},
		{"/a*", false},
		{"/.", false},
		{"/apps/..", false},
	} {
		if got := ValidBasePath(tc.path); got != tc.want {
			t.Errorf("ValidBasePath(%q) = %v, want %v", tc.path, got, tc.want)
		}
	}
}

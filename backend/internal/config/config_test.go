package config

import (
	"os"
	"strings"
	"testing"
)

func withEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for k, v := range kv {
		t.Setenv(k, v)
	}
}

func oidcEnv(extra map[string]string) map[string]string {
	e := map[string]string{
		"BACKEND_AUTH_MODE":          "oidc",
		"BACKEND_SESSION_SECRET":     "s",
		"BACKEND_PUBLIC_URL":         "https://host.example/transmission",
		"BACKEND_OIDC_ISSUER":        "https://idp.example",
		"BACKEND_OIDC_CLIENT_ID":     "id",
		"BACKEND_OIDC_CLIENT_SECRET": "secret",
		"BACKEND_OIDC_REDIRECT_URL":  "https://host.example/transmission/api/auth/callback",
		"TM_USER":                    "u",
		"TM_PASS":                    "p",
	}
	for k, v := range extra {
		e[k] = v
	}
	return e
}

// A redirect URL outside the public URL's path 404s after the IdP round-trip,
// which only shows up on a real login. Refuse it at startup instead.
func TestRedirectURLMustSitUnderPublicURL(t *testing.T) {
	withEnv(t, oidcEnv(map[string]string{
		"BACKEND_OIDC_REDIRECT_URL": "https://host.example/api/auth/callback",
	}))
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "must sit under") {
		t.Fatalf("want a redirect-url complaint, got %v", err)
	}
}

func TestRedirectURLUnderPrefixIsAccepted(t *testing.T) {
	withEnv(t, oidcEnv(nil))
	cfg, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.BasePath != "/transmission" {
		t.Fatalf("base path: got %q", cfg.BasePath)
	}
	if !cfg.SecureCookies {
		t.Fatal("https public url should get secure cookies")
	}
}

func TestLoopbackPublicURLDropsSecureCookies(t *testing.T) {
	for _, u := range []string{"http://127.0.0.1:8127", "http://localhost:8127"} {
		os.Clearenv()
		withEnv(t, map[string]string{
			"BACKEND_AUTH_MODE":  "form",
			"BACKEND_PUBLIC_URL": u,
			"TM_USER":            "u",
			"TM_PASS":            "p",
		})
		cfg, err := Load()
		if err != nil {
			t.Fatalf("%s: load: %v", u, err)
		}
		if cfg.SecureCookies {
			t.Fatalf("%s: want insecure cookies on loopback", u)
		}
	}
}

// Form mode without a secret still starts, but the caller must be able to warn.
func TestFormModeGeneratesSessionSecret(t *testing.T) {
	os.Clearenv()
	withEnv(t, map[string]string{
		"BACKEND_AUTH_MODE":  "form",
		"BACKEND_PUBLIC_URL": "https://host.example",
		"TM_USER":            "u",
		"TM_PASS":            "p",
	})
	cfg, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !cfg.GeneratedSessionSecret {
		t.Fatal("generated secret not flagged")
	}
	if cfg.SessionSecret == "" {
		t.Fatal("no secret generated")
	}
}

func TestFormModeRequiresPassword(t *testing.T) {
	os.Clearenv()
	withEnv(t, map[string]string{
		"BACKEND_AUTH_MODE": "form",
		"TM_USER":           "u",
	})
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "TM_PASS") {
		t.Fatalf("want a TM_PASS complaint, got %v", err)
	}
}

func TestUnknownAuthModeRejected(t *testing.T) {
	os.Clearenv()
	withEnv(t, map[string]string{"BACKEND_AUTH_MODE": "dev", "TM_USER": "u", "TM_PASS": "p"})
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "BACKEND_AUTH_MODE") {
		t.Fatalf("dev mode should be gone, got %v", err)
	}
}

// Nothing can supply a group in form mode, so the setting must not gate it:
// left in force, it shut out sessions issued before it was last changed.
func TestFormModeIgnoresAllowedGroup(t *testing.T) {
	os.Clearenv()
	withEnv(t, map[string]string{
		"BACKEND_AUTH_MODE":          "form",
		"BACKEND_PUBLIC_URL":         "https://host.example",
		"BACKEND_OIDC_ALLOWED_GROUP": "media",
		"TM_USER":                    "u",
		"TM_PASS":                    "p",
	})
	cfg, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.OIDCAllowedGroup != "" {
		t.Fatalf("allowed group still in force in form mode: %q", cfg.OIDCAllowedGroup)
	}
}

// The missing settings are listed in the same order on every start.
func TestMissingOIDCSettingsAreListedInOrder(t *testing.T) {
	os.Clearenv()
	withEnv(t, map[string]string{"BACKEND_AUTH_MODE": "oidc", "TM_USER": "u"})
	_, err := Load()
	if err == nil {
		t.Fatal("want an error")
	}
	issuer, redirect := strings.Index(err.Error(), "BACKEND_OIDC_ISSUER"), strings.Index(err.Error(), "BACKEND_OIDC_REDIRECT_URL")
	if issuer < 0 || redirect < issuer {
		t.Fatalf("want issuer listed before redirect URL: %v", err)
	}
}

// The app is built to sit behind a TLS-terminating reverse proxy. Over plain
// http the browser drops the Secure session cookie and sign-in loops, so a
// deployment without one is refused at startup instead, in either auth mode.
func TestPublicURLMustBeHTTPS(t *testing.T) {
	for _, tc := range []struct {
		name, url string
		ok        bool
	}{
		{"https", "https://host.example", true},
		{"https with a prefix", "https://host.example/transmission", true},
		{"loopback http, for local runs", "http://127.0.0.1:8127", true},
		{"localhost http", "http://localhost:8127", true},
		{"unset", "", false},
		{"plain http on a LAN address", "http://192.168.1.20:8080", false},
		{"plain http on a hostname", "http://seedbox.lan", false},
		{"no scheme", "host.example", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			os.Clearenv()
			withEnv(t, map[string]string{
				"BACKEND_AUTH_MODE":  "form",
				"BACKEND_PUBLIC_URL": tc.url,
				"TM_USER":            "u",
				"TM_PASS":            "p",
			})
			_, err := Load()
			if tc.ok && err != nil {
				t.Fatalf("want it to start, got %v", err)
			}
			if !tc.ok && (err == nil || !strings.Contains(err.Error(), "BACKEND_PUBLIC_URL")) {
				t.Fatalf("want a BACKEND_PUBLIC_URL complaint, got %v", err)
			}
		})
	}
}

func TestPublicURLMustBeHTTPSInOIDCModeToo(t *testing.T) {
	os.Clearenv()
	withEnv(t, oidcEnv(map[string]string{
		"BACKEND_PUBLIC_URL":        "http://host.example/transmission",
		"BACKEND_OIDC_REDIRECT_URL": "http://host.example/transmission/api/auth/callback",
	}))
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "must be https") {
		t.Fatalf("want an https complaint, got %v", err)
	}
}

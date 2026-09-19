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
		"BACKEND_AUTH_MODE": "form",
		"TM_USER":           "u",
		"TM_PASS":           "p",
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

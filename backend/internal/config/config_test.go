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
		"BACKEND_SESSION_SECRET":     "0123456789abcdef0123456789abcdef",
		"BACKEND_PUBLIC_URL":         "https://host.example/transmission",
		"BACKEND_OIDC_ISSUER":        "https://idp.example",
		"BACKEND_OIDC_CLIENT_ID":     "id",
		"BACKEND_OIDC_CLIENT_SECRET": "secret",
		"BACKEND_OIDC_REDIRECT_URL":  "https://host.example/transmission/api/auth/callback",
		"TRANSMISSION_USER":          "u",
		"TRANSMISSION_PASSWORD":      "p",
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
			"BACKEND_AUTH_MODE":     "form",
			"BACKEND_PUBLIC_URL":    u,
			"TRANSMISSION_USER":     "u",
			"TRANSMISSION_PASSWORD": "p",
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
		"BACKEND_AUTH_MODE":     "form",
		"BACKEND_PUBLIC_URL":    "https://host.example",
		"TRANSMISSION_USER":     "u",
		"TRANSMISSION_PASSWORD": "p",
	})
	cfg, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !cfg.GeneratedSessionSecret {
		t.Fatal("generated secret not flagged")
	}
	if len(cfg.SessionKey) < 32 {
		t.Fatalf("no usable key generated: %d bytes", len(cfg.SessionKey))
	}
}

func TestFormModeRequiresPassword(t *testing.T) {
	os.Clearenv()
	withEnv(t, map[string]string{
		"BACKEND_AUTH_MODE": "form",
		"TRANSMISSION_USER": "u",
	})
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "TRANSMISSION_PASSWORD") {
		t.Fatalf("want a TRANSMISSION_PASSWORD complaint, got %v", err)
	}
}

func TestUnknownAuthModeRejected(t *testing.T) {
	os.Clearenv()
	withEnv(t, map[string]string{"BACKEND_AUTH_MODE": "dev", "TRANSMISSION_USER": "u", "TRANSMISSION_PASSWORD": "p"})
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
		"TRANSMISSION_USER":          "u",
		"TRANSMISSION_PASSWORD":      "p",
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
	withEnv(t, map[string]string{"BACKEND_AUTH_MODE": "oidc", "TRANSMISSION_USER": "u"})
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
		{"https in capitals", "HTTPS://host.example", true},
		{"https without a host", "https://", false},
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
				"BACKEND_AUTH_MODE":     "form",
				"BACKEND_PUBLIC_URL":    tc.url,
				"TRANSMISSION_USER":     "u",
				"TRANSMISSION_PASSWORD": "p",
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

// kit's session signer refuses a key under 32 bytes; say so with the others at
// startup rather than failing later with a name-less error.
func TestShortSessionSecretRejected(t *testing.T) {
	withEnv(t, oidcEnv(map[string]string{"BACKEND_SESSION_SECRET": "short"}))
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "at least 32 bytes") {
		t.Fatalf("want a secret length complaint, got %v", err)
	}
}

// An unfilled .env line arrives as an empty string: the same fault as unset.
func TestEmptyRequiredVarIsAFault(t *testing.T) {
	withEnv(t, oidcEnv(map[string]string{"BACKEND_OIDC_ISSUER": "", "TRANSMISSION_USER": ""}))
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "BACKEND_OIDC_ISSUER is required") || !strings.Contains(err.Error(), "TRANSMISSION_USER is required") {
		t.Fatalf("want both empty vars reported, got %v", err)
	}
}

func TestConfiguredSecretIsTheKey(t *testing.T) {
	withEnv(t, oidcEnv(nil))
	cfg, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if string(cfg.SessionKey) != "0123456789abcdef0123456789abcdef" || cfg.GeneratedSessionSecret {
		t.Fatalf("configured secret not used as the key: %q", cfg.SessionKey)
	}
}

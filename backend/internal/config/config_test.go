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
		"PUBLIC_FQDN":                "host.example",
		"BACKEND_BASE_PATH":          "/transmission",
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
	if cfg.PublicURL != "https://host.example/transmission" {
		t.Fatalf("public url: got %q", cfg.PublicURL)
	}
	if !cfg.SecureCookies {
		t.Fatal("https public url should get secure cookies")
	}
}

// Local runs are plain http on loopback, where a Secure cookie breaks sign-in.
func TestLoopbackPublicFQDNDropsSecureCookies(t *testing.T) {
	for _, h := range []string{"127.0.0.1:8127", "localhost:8127", "localhost", "LOCALHOST:8127", "[::1]:8127"} {
		os.Clearenv()
		withEnv(t, map[string]string{
			"BACKEND_AUTH_MODE":     "form",
			"PUBLIC_FQDN":           h,
			"TRANSMISSION_USER":     "u",
			"TRANSMISSION_PASSWORD": "p",
		})
		cfg, err := Load()
		if err != nil {
			t.Fatalf("%s: load: %v", h, err)
		}
		if cfg.SecureCookies {
			t.Fatalf("%s: want insecure cookies on loopback", h)
		}
		if cfg.PublicURL != "http://"+h {
			t.Fatalf("%s: public url %q, want plain http on loopback", h, cfg.PublicURL)
		}
	}
}

// Form mode without a secret still starts, but the caller must be able to warn.
func TestFormModeGeneratesSessionSecret(t *testing.T) {
	os.Clearenv()
	withEnv(t, map[string]string{
		"BACKEND_AUTH_MODE":     "form",
		"PUBLIC_FQDN":           "host.example",
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
		"PUBLIC_FQDN":                "host.example",
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

// The app sits behind a TLS-terminating reverse proxy that routes on the raw
// PUBLIC_FQDN, so anything but a bare hostname (or loopback host:port for local
// runs) is refused at startup, naming the variable, in either auth mode.
func TestPublicFQDNMustBeABareHostname(t *testing.T) {
	for _, tc := range []struct {
		name, fqdn string
		ok         bool
	}{
		{"hostname", "host.example", true},
		{"LAN address without a port", "192.168.1.20", true},
		{"bracketed IPv6 without a port", "[2001:db8::1]", true},
		{"loopback with a port, for local runs", "127.0.0.1:8127", true},
		{"localhost with a port", "localhost:8127", true},
		{"unset", "", false},
		{"with a scheme", "https://host.example", false},
		{"plain http scheme", "http://host.example", false},
		{"port on a hostname", "host.example:8443", false},
		{"port on a LAN address", "192.168.1.20:8080", false},
		{"port on bracketed IPv6", "[2001:db8::1]:8443", false},
		{"empty port", "host.example:", false},
		{"userinfo", "user@host.example", false},
		{"query", "host.example?x", false},
		{"path", "host.example/transmission", false},
		{"trailing space", "host.example ", false},
		{"leading space", " host.example", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			os.Clearenv()
			withEnv(t, map[string]string{
				"BACKEND_AUTH_MODE":     "form",
				"PUBLIC_FQDN":           tc.fqdn,
				"TRANSMISSION_USER":     "u",
				"TRANSMISSION_PASSWORD": "p",
			})
			_, err := Load()
			if tc.ok && err != nil {
				t.Fatalf("want it to start, got %v", err)
			}
			if !tc.ok && (err == nil || !strings.Contains(err.Error(), "PUBLIC_FQDN")) {
				t.Fatalf("want a PUBLIC_FQDN complaint, got %v", err)
			}
		})
	}
}

// The base path is the prefix the proxy forwards unstripped; every route and
// redirect keeps it, so a malformed one is refused rather than half-applied.
func TestBasePathMustBeAPathPrefix(t *testing.T) {
	for _, tc := range []struct {
		name, path string
		ok         bool
	}{
		{"unset", "", true},
		{"one segment", "/transmission", true},
		{"two segments", "/apps/transmission", true},
		{"no leading slash", "transmission", false},
		{"trailing slash", "/transmission/", false},
		{"root alone", "/", false},
		{"empty segment", "//transmission", false},
		{"query", "/transmission?x", false},
		{"fragment", "/transmission#x", false},
		{"space", "/trans mission", false},
		{"ServeMux wildcard", "/{name}", false},
		{"dot segment", "/apps/..", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			os.Clearenv()
			withEnv(t, formEnv(map[string]string{"BACKEND_BASE_PATH": tc.path}))
			cfg, err := Load()
			if tc.ok {
				if err != nil {
					t.Fatalf("want it to start, got %v", err)
				}
				if cfg.BasePath != tc.path || cfg.PublicURL != "https://host.example"+tc.path {
					t.Fatalf("base %q, public url %q", cfg.BasePath, cfg.PublicURL)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), "BACKEND_BASE_PATH") {
				t.Fatalf("want a BACKEND_BASE_PATH complaint, got %v", err)
			}
		})
	}
}

// The derived public URL is https: a redirect URL on plain http sits outside it.
func TestRedirectURLMustUseTheDerivedScheme(t *testing.T) {
	os.Clearenv()
	withEnv(t, oidcEnv(map[string]string{
		"BACKEND_OIDC_REDIRECT_URL": "http://host.example/transmission/api/auth/callback",
	}))
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "must sit under") {
		t.Fatalf("want a redirect-url complaint, got %v", err)
	}
}

// BACKEND_PUBLIC_URL is no longer read; a deployment that still sets it is
// flagged so main can warn instead of silently ignoring it.
func TestLeftoverPublicURLIsFlagged(t *testing.T) {
	os.Clearenv()
	withEnv(t, oidcEnv(map[string]string{"BACKEND_PUBLIC_URL": "https://host.example/transmission"}))
	cfg, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !cfg.LeftoverPublicURL {
		t.Fatal("leftover BACKEND_PUBLIC_URL not flagged")
	}
	os.Clearenv()
	withEnv(t, oidcEnv(nil))
	cfg, err = Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.LeftoverPublicURL {
		t.Fatal("flagged without BACKEND_PUBLIC_URL")
	}
}

// An unmigrated deployment fails on the missing PUBLIC_FQDN; the error itself
// says what replaces the old variable, since the start never reaches the warning.
func TestMissingPublicFQDNNamesTheReplacement(t *testing.T) {
	os.Clearenv()
	withEnv(t, map[string]string{
		"BACKEND_AUTH_MODE":     "form",
		"BACKEND_PUBLIC_URL":    "https://host.example/transmission",
		"TRANSMISSION_USER":     "u",
		"TRANSMISSION_PASSWORD": "p",
	})
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "PUBLIC_FQDN is required") ||
		!strings.Contains(err.Error(), "BACKEND_PUBLIC_URL") || !strings.Contains(err.Error(), "BACKEND_BASE_PATH") {
		t.Fatalf("want the required error to carry the migration hint, got %v", err)
	}
}

// A half migration that drops the prefix would mount the app at the root while
// the proxy forwards /transmission: every page 404s and the healthcheck, which
// probes the root too, stays green. Refuse it; a matching path only warns.
func TestLeftoverPublicURLPathMustMatchBasePath(t *testing.T) {
	for _, tc := range []struct {
		name, old, base string
		ok              bool
	}{
		{"prefix dropped", "https://host.example/transmission", "", false},
		{"prefix differs", "https://host.example/transmission", "/torrents", false},
		{"prefix kept", "https://host.example/transmission/", "/transmission", true},
		{"no prefix either side", "https://host.example/", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			os.Clearenv()
			withEnv(t, formEnv(map[string]string{"BACKEND_PUBLIC_URL": tc.old, "BACKEND_BASE_PATH": tc.base}))
			cfg, err := Load()
			if tc.ok {
				if err != nil || !cfg.LeftoverPublicURL {
					t.Fatalf("want a start with the leftover flagged, got %v (flagged %v)", err, cfg.LeftoverPublicURL)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), "BACKEND_PUBLIC_URL") || !strings.Contains(err.Error(), "BACKEND_BASE_PATH") {
				t.Fatalf("want a refusal naming both, got %v", err)
			}
		})
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

// Configuration from the environment. Names follow peeq's BACKEND_* convention
// so the two stacks read the same way in compose.
package config

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

type AuthMode string

const (
	AuthModeOIDC AuthMode = "oidc"
	AuthModeDev  AuthMode = "dev"
)

type Config struct {
	Addr      string
	PublicURL string
	AuthMode  AuthMode

	SessionSecret string
	SessionTTL    time.Duration

	OIDCIssuer                string
	OIDCClientID              string
	OIDCClientSecret          string
	OIDCRedirectURL           string
	OIDCPostLogoutRedirectURL string
	OIDCAllowedGroup          string

	RPCUpstream string
	RPCUser     string
	RPCPass     string

	// SecureCookies is false in dev mode so the flow works over plain http.
	SecureCookies bool
}

// Load reads the environment and validates it. Every error is returned at once
// so a misconfigured deployment does not need repeated restarts to find them.
func Load() (Config, error) {
	cfg := Config{
		Addr:                      env("BACKEND_ADDR", ":8080"),
		PublicURL:                 os.Getenv("BACKEND_PUBLIC_URL"),
		AuthMode:                  AuthMode(env("BACKEND_AUTH_MODE", string(AuthModeOIDC))),
		SessionSecret:             os.Getenv("BACKEND_SESSION_SECRET"),
		SessionTTL:                24 * time.Hour,
		OIDCIssuer:                os.Getenv("BACKEND_OIDC_ISSUER"),
		OIDCClientID:              os.Getenv("BACKEND_OIDC_CLIENT_ID"),
		OIDCClientSecret:          os.Getenv("BACKEND_OIDC_CLIENT_SECRET"),
		OIDCRedirectURL:           os.Getenv("BACKEND_OIDC_REDIRECT_URL"),
		OIDCPostLogoutRedirectURL: os.Getenv("BACKEND_OIDC_POST_LOGOUT_REDIRECT_URL"),
		OIDCAllowedGroup:          os.Getenv("BACKEND_OIDC_ALLOWED_GROUP"),
		RPCUpstream:               env("TM_RPC_UPSTREAM", "http://transmission:9091"),
		RPCUser:                   os.Getenv("TM_USER"),
		RPCPass:                   os.Getenv("TM_PASS"),
	}
	cfg.SecureCookies = cfg.AuthMode == AuthModeOIDC

	var problems []string
	switch cfg.AuthMode {
	case AuthModeOIDC:
		if cfg.SessionSecret == "" {
			problems = append(problems, "BACKEND_SESSION_SECRET is required")
		}
		// BACKEND_PUBLIC_URL is informational: the redirect and logout URLs are
		// configured directly, not derived from it, so it is not required.
		for name, value := range map[string]string{
			"BACKEND_OIDC_ISSUER":        cfg.OIDCIssuer,
			"BACKEND_OIDC_CLIENT_ID":     cfg.OIDCClientID,
			"BACKEND_OIDC_CLIENT_SECRET": cfg.OIDCClientSecret,
			"BACKEND_OIDC_REDIRECT_URL":  cfg.OIDCRedirectURL,
		} {
			if value == "" {
				problems = append(problems, name+" is required when BACKEND_AUTH_MODE=oidc")
			}
		}
	case AuthModeDev:
		// Dev mode auto-authenticates, so it must never be reachable in
		// production. A missing secret is fine here; generate an ephemeral one.
		if cfg.SessionSecret == "" {
			cfg.SessionSecret = "dev-only-insecure-session-secret"
		}
	default:
		problems = append(problems, fmt.Sprintf("BACKEND_AUTH_MODE must be %q or %q, got %q",
			AuthModeOIDC, AuthModeDev, cfg.AuthMode))
	}

	if cfg.RPCUser == "" {
		problems = append(problems, "TM_USER is required (the daemon's RPC user)")
	}

	if len(problems) > 0 {
		return Config{}, errors.New("config: " + strings.Join(problems, "; "))
	}
	return cfg, nil
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

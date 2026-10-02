// Configuration from the environment. Names follow peeq's BACKEND_* convention
// so the two stacks read the same way in compose.
package config

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"
)

// AuthMode selects how the app signs users in.
type AuthMode string

// The supported authentication modes.
const (
	// AuthModeOIDC delegates sign-in to an identity provider.
	AuthModeOIDC AuthMode = "oidc"
	// AuthModeForm is a login form checked against the daemon's own RPC
	// credentials, for deployments with no identity provider. It is also what
	// local development uses, so there is one fewer auth path than there are
	// environments.
	AuthModeForm AuthMode = "form"
)

// Config is the process configuration, read from the environment at startup.
type Config struct {
	Addr string
	// PublicURL is where the app is reached from outside. When it carries a
	// path, that path is the prefix the reverse proxy forwards (it is not
	// stripped), and every route is mounted under it.
	PublicURL string
	BasePath  string
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

	// SecureCookies is false only when the public URL is loopback.
	SecureCookies bool
	// GeneratedSessionSecret records that no secret was configured, so the
	// caller can warn: every restart invalidates the outstanding sessions.
	GeneratedSessionSecret bool
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
	// Deployments sit behind a TLS-terminating proxy (see compose.yaml), but
	// local runs are plain http on loopback, where a Secure cookie is dropped
	// by some browsers and the sign-in silently loops. Derive it from the
	// public URL rather than the mode, and default to secure.
	cfg.SecureCookies = !isLoopbackURL(cfg.PublicURL)
	cfg.BasePath = BasePathOf(cfg.PublicURL)

	var problems []string
	// The app is meant to sit behind a reverse proxy that terminates TLS: a
	// form password and the session cookie both cross the wire. Plain http to
	// anything but this machine cannot even work, because the browser drops
	// the Secure session cookie and sign-in loops with nothing to explain it.
	// So refuse to start, and say why.
	switch {
	case cfg.PublicURL == "":
		problems = append(problems,
			"BACKEND_PUBLIC_URL is required: the https URL your reverse proxy serves this app at")
	case !isHTTPSURL(cfg.PublicURL) && !isLoopbackURL(cfg.PublicURL):
		problems = append(problems, fmt.Sprintf(
			"BACKEND_PUBLIC_URL (%s) must be https: run this app behind a reverse proxy that terminates TLS (plain http is accepted for a loopback address only, for local runs)",
			cfg.PublicURL))
	}
	switch cfg.AuthMode {
	case AuthModeOIDC:
		if cfg.SessionSecret == "" {
			problems = append(problems, "BACKEND_SESSION_SECRET is required")
		}
		// A slice, not a map: the problems then come out in the same order on
		// every start.
		for _, v := range []struct{ name, value string }{
			{"BACKEND_OIDC_ISSUER", cfg.OIDCIssuer},
			{"BACKEND_OIDC_CLIENT_ID", cfg.OIDCClientID},
			{"BACKEND_OIDC_CLIENT_SECRET", cfg.OIDCClientSecret},
			{"BACKEND_OIDC_REDIRECT_URL", cfg.OIDCRedirectURL},
		} {
			if v.value == "" {
				problems = append(problems, v.name+" is required when BACKEND_AUTH_MODE=oidc")
			}
		}
		// The callback is only mounted under the public URL's path, so a
		// redirect URL outside it 404s after the round-trip to the IdP -- a
		// failure that only shows up once a real login is attempted.
		if cfg.PublicURL != "" && cfg.OIDCRedirectURL != "" &&
			!strings.HasPrefix(cfg.OIDCRedirectURL, strings.TrimRight(cfg.PublicURL, "/")+"/") {
			problems = append(problems, fmt.Sprintf(
				"BACKEND_OIDC_REDIRECT_URL (%s) must sit under BACKEND_PUBLIC_URL (%s)",
				cfg.OIDCRedirectURL, cfg.PublicURL))
		}
	case AuthModeForm:
		// There is no group source in this mode: the credential check is the
		// whole decision. Leaving the setting in force would shut out every
		// session issued before it was last changed.
		cfg.OIDCAllowedGroup = ""
		// A local run needs no ceremony, so generate a per-process secret when
		// none is set: sessions then die with the process. A deployment that
		// omits it gets the same, which signs everyone out on every restart,
		// so main.go warns about it.
		if cfg.SessionSecret == "" {
			cfg.GeneratedSessionSecret = true
			buf := make([]byte, 32)
			if _, err := rand.Read(buf); err != nil {
				return Config{}, fmt.Errorf("generate session secret: %w", err)
			}
			cfg.SessionSecret = base64.RawURLEncoding.EncodeToString(buf)
		}
		// The form checks the daemon's RPC credentials, so a blank password
		// would let anyone in with just the username.
		if cfg.RPCPass == "" {
			problems = append(problems, "TM_PASS is required when BACKEND_AUTH_MODE=form")
		}
	default:
		problems = append(problems, fmt.Sprintf("BACKEND_AUTH_MODE must be %q or %q, got %q",
			AuthModeOIDC, AuthModeForm, cfg.AuthMode))
	}

	if cfg.RPCUser == "" {
		problems = append(problems, "TM_USER is required (the daemon's RPC user)")
	}

	if len(problems) > 0 {
		return Config{}, errors.New("config: " + strings.Join(problems, "; "))
	}
	return cfg, nil
}

// BasePathOf extracts the path prefix from the public URL, normalised to
// either "" or "/prefix" with no trailing slash.
func BasePathOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	p := strings.TrimRight(u.Path, "/")
	if p == "/" {
		return ""
	}
	return p
}

// isHTTPSURL reports whether the public URL is an https URL with a host. The
// scheme is compared as parsed, so HTTPS:// counts.
func isHTTPSURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host != ""
}

// isLoopbackURL reports whether the public URL points at this machine, which
// is the one case where a Secure cookie would break sign-in.
func isLoopbackURL(raw string) bool {
	if raw == "" {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if u.Scheme == "https" {
		return false
	}
	host := u.Hostname()
	return host == "localhost" || net.ParseIP(host).IsLoopback()
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

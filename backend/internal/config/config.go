// Configuration from the environment. Names follow peeq's BACKEND_* convention
// so the two stacks read the same way in compose.
package config

import (
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/trick77/ship/kit/auth"
	"github.com/trick77/ship/kit/env"
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

// minSessionSecret is the shortest key kit's session signer accepts.
const minSessionSecret = 32

// Config is the process configuration, read from the environment at startup.
type Config struct {
	Addr string
	// PublicURL is where the app is reached from outside:
	// https://<PUBLIC_FQDN><BACKEND_BASE_PATH>, plain http for a loopback host.
	PublicURL string
	// BasePath is the prefix the reverse proxy forwards (it is not stripped);
	// every route is mounted under it.
	BasePath string
	AuthMode AuthMode

	SessionKey []byte
	SessionTTL time.Duration

	OIDCIssuer                string
	OIDCClientID              string
	OIDCClientSecret          string
	OIDCRedirectURL           string
	OIDCPostLogoutRedirectURL string
	OIDCAllowedGroup          string

	RPCUpstream string
	RPCUser     string
	RPCPass     string

	// DataRoots and DaemonConfig enable the orphan finder; both empty means it
	// is off. See loadMounts.
	DataRoots    []Mount
	DaemonConfig Mount

	// SecureCookies is false only when the public URL is loopback.
	SecureCookies bool
	// LeftoverPublicURL records that BACKEND_PUBLIC_URL is still set, so the
	// caller can warn: it is no longer read.
	LeftoverPublicURL bool
	// GeneratedSessionSecret records that no secret was configured, so the
	// caller can warn: every restart invalidates the outstanding sessions.
	GeneratedSessionSecret bool
}

// Load reads the environment and validates it. Every fault is returned at once
// so a misconfigured deployment does not need repeated restarts to find them.
// A variable set to the empty string counts as unset (an unfilled .env line).
func Load() (Config, error) {
	r := env.New(os.Getenv)
	cfg := Config{
		Addr: r.String("BACKEND_ADDR", ":8080"),
		AuthMode: AuthMode(r.Enum("BACKEND_AUTH_MODE", string(AuthModeOIDC),
			string(AuthModeOIDC), string(AuthModeForm))),
		SessionTTL:                24 * time.Hour,
		OIDCPostLogoutRedirectURL: r.String("BACKEND_OIDC_POST_LOGOUT_REDIRECT_URL", ""),
		OIDCAllowedGroup:          r.String("BACKEND_OIDC_ALLOWED_GROUP", ""),
		RPCUpstream:               r.String("TRANSMISSION_RPC_UPSTREAM", "http://transmission:9091"),
	}
	secret := r.String("BACKEND_SESSION_SECRET", "")
	cfg.LeftoverPublicURL = os.Getenv("BACKEND_PUBLIC_URL") != ""
	loadPublicURL(r, &cfg)
	switch cfg.AuthMode {
	case AuthModeOIDC:
		if secret == "" {
			r.Fail("BACKEND_SESSION_SECRET is required when BACKEND_AUTH_MODE=oidc")
		}
		cfg.OIDCIssuer = r.Required("BACKEND_OIDC_ISSUER")
		cfg.OIDCClientID = r.Required("BACKEND_OIDC_CLIENT_ID")
		cfg.OIDCClientSecret = r.Required("BACKEND_OIDC_CLIENT_SECRET")
		cfg.OIDCRedirectURL = r.Required("BACKEND_OIDC_REDIRECT_URL")
		// The callback is only mounted under the public URL's path, so a
		// redirect URL outside it 404s after the round-trip to the IdP -- a
		// failure that only shows up once a real login is attempted.
		if cfg.OIDCRedirectURL != "" &&
			!strings.HasPrefix(cfg.OIDCRedirectURL, strings.TrimRight(cfg.PublicURL, "/")+"/") {
			r.Fail("BACKEND_OIDC_REDIRECT_URL (%s) must sit under https://<PUBLIC_FQDN><BACKEND_BASE_PATH> (%s)",
				cfg.OIDCRedirectURL, cfg.PublicURL)
		}
		cfg.RPCPass = r.String("TRANSMISSION_PASSWORD", "")
	case AuthModeForm:
		// There is no group source in this mode: the credential check is the
		// whole decision. Leaving the setting in force would shut out every
		// session issued before it was last changed.
		cfg.OIDCAllowedGroup = ""
		// A local run needs no ceremony, so generate a per-process key when no
		// secret is set: sessions then die with the process. A deployment that
		// omits it gets the same, which signs everyone out on every restart,
		// so main.go warns about it.
		if secret == "" {
			cfg.GeneratedSessionSecret = true
			cfg.SessionKey = auth.RandomKey()
		}
		// The form checks the daemon's RPC credentials, so a blank password
		// would let anyone in with just the username.
		cfg.RPCPass = r.Required("TRANSMISSION_PASSWORD")
	}
	if secret != "" {
		// The secret signs every session: a short one is a startup error, not
		// a weak cookie.
		if len(secret) < minSessionSecret {
			r.Fail("BACKEND_SESSION_SECRET must be at least %d bytes, e.g. openssl rand -base64 48", minSessionSecret)
		}
		cfg.SessionKey = []byte(secret)
	}
	cfg.RPCUser = r.Required("TRANSMISSION_USER")
	loadMounts(r, &cfg)

	if err := r.Err(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// loadPublicURL derives the public URL from the hostname the proxy routes on
// and the prefix it forwards; neither is ever configured as a URL a second
// time. Both are read raw: kit's reader trims, but the proxy matches the raw
// value, so a stray space must fail here rather than disagree with it.
func loadPublicURL(r *env.Reader, cfg *Config) {
	fqdn := os.Getenv("PUBLIC_FQDN")
	base := os.Getenv("BACKEND_BASE_PATH")
	leftover := os.Getenv("BACKEND_PUBLIC_URL")
	// Deployments sit behind a TLS-terminating proxy (see compose.yaml): a
	// form password and the session cookie both cross the wire, and over plain
	// http the browser drops the Secure cookie and sign-in loops with nothing
	// to explain it. Local runs are the one exception, plain http on loopback
	// with an insecure cookie. Default to secure.
	cfg.SecureCookies = true
	scheme := "https"
	switch {
	case fqdn == "" && leftover != "":
		// An unmigrated deployment never reaches main's warning: say it here.
		r.Fail("PUBLIC_FQDN is required: the hostname your reverse proxy serves this app on; "+
			"BACKEND_PUBLIC_URL (%s) is no longer read: set PUBLIC_FQDN to its host and BACKEND_BASE_PATH to its path",
			leftover)
		return
	case fqdn == "":
		r.Fail("PUBLIC_FQDN is required: the hostname your reverse proxy serves this app on")
		return
	case isLoopbackHost(fqdn):
		scheme = "http"
		cfg.SecureCookies = false
	case !isBareHost(fqdn):
		r.Fail("PUBLIC_FQDN (%q) must be a bare hostname such as transmission.example.com: no scheme, port, "+
			"path or spaces (host:port over plain http is accepted for a loopback address only, for local runs)", fqdn)
		return
	}
	if !ValidBasePath(base) {
		r.Fail("BACKEND_BASE_PATH (%q) must be empty or a path prefix like /transmission: "+
			"leading slash, no trailing slash, segments of letters, digits and ._~- only", base)
		return
	}
	// A half migration that dropped the prefix mounts the app at the root
	// while the proxy forwards it, and the healthcheck probes the root too, so
	// it stays green through the outage. A matching path only warns (main).
	if leftover != "" {
		if old := leftoverPath(leftover); old != base {
			r.Fail("BACKEND_PUBLIC_URL (%s) is no longer read, and its path %q differs from BACKEND_BASE_PATH (%q): "+
				"set BACKEND_BASE_PATH to the prefix the proxy forwards and remove BACKEND_PUBLIC_URL", leftover, old, base)
			return
		}
	}
	cfg.BasePath = base
	cfg.PublicURL = scheme + "://" + fqdn + base
}

// leftoverPath is the path of a leftover BACKEND_PUBLIC_URL, normalised like
// BACKEND_BASE_PATH: "" or "/prefix" without a trailing slash.
func leftoverPath(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return strings.TrimRight(u.Path, "/")
}

// ValidBasePath reports whether p is "" or a path prefix such as
// /transmission: what the proxy forwards and every route is mounted under.
// Segments are plain unreserved characters: a brace is a ServeMux wildcard
// (registering it panics), and dot segments or escapes never match a request.
func ValidBasePath(p string) bool {
	if p == "" {
		return true
	}
	if !strings.HasPrefix(p, "/") {
		return false
	}
	for _, seg := range strings.Split(p[1:], "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
		if strings.IndexFunc(seg, notUnreserved) >= 0 {
			return false
		}
	}
	return true
}

// notUnreserved reports whether c falls outside RFC 3986's unreserved set.
func notUnreserved(c rune) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return false
	default:
		return !strings.ContainsRune("._~-", c)
	}
}

// isBareHost reports whether v is a hostname (or bracketed IPv6 literal) and
// nothing else: no scheme, port, userinfo, path, query or surrounding space.
func isBareHost(v string) bool {
	u, err := url.Parse("https://" + v)
	return err == nil && u.Host == v && u.Port() == "" && !strings.HasSuffix(v, ":")
}

// isLoopbackHost reports whether v is this machine as host[:port], the one
// case where plain http and an insecure cookie are right.
func isLoopbackHost(v string) bool {
	u, err := url.Parse("http://" + v)
	if err != nil || u.Host != v {
		return false
	}
	host := u.Hostname()
	return strings.EqualFold(host, "localhost") || net.ParseIP(host).IsLoopback()
}

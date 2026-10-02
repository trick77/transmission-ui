// transmission-ui backend: serves the built UI, terminates OIDC against
// Authelia, and proxies RPC to the daemon with its basic auth attached.
package main

import (
	"context"
	"embed"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/trick77/transmission-ui/backend/internal/auth"
	"github.com/trick77/transmission-ui/backend/internal/config"
	"github.com/trick77/transmission-ui/backend/internal/httpapi"
	"github.com/trick77/transmission-ui/backend/internal/proxy"
)

// The Containerfile copies the Vite build here before `go build`.
//
//go:embed all:dist
var distFS embed.FS

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	// The runtime image is distroless: no shell, no wget, so the container
	// healthcheck re-executes this binary instead.
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		os.Exit(healthcheck())
	}

	cfg, err := config.Load()
	if err != nil {
		log.Error("startup", "err", err)
		os.Exit(1)
	}

	ui, err := fs.Sub(distFS, "dist")
	if err != nil {
		log.Error("embed dist", "err", err)
		os.Exit(1)
	}

	rpc, err := proxy.New(proxy.Config{
		Upstream: cfg.RPCUpstream,
		User:     cfg.RPCUser,
		Pass:     cfg.RPCPass,
		Log:      log,
	})
	if err != nil {
		log.Error("rpc proxy", "err", err)
		os.Exit(1)
	}

	var oidcService httpapi.OIDC
	if cfg.AuthMode == config.AuthModeOIDC {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		svc, err := auth.NewOIDCServiceFromDiscovery(ctx, auth.OIDCServiceConfig{
			Issuer:       cfg.OIDCIssuer,
			ClientID:     cfg.OIDCClientID,
			ClientSecret: cfg.OIDCClientSecret,
			RedirectURL:  cfg.OIDCRedirectURL,
			SecureCookie: cfg.SecureCookies,
			BasePath:     cfg.BasePath,
		})
		if err != nil {
			log.Error("oidc discovery", "err", err)
			os.Exit(1)
		}
		oidcService = svc
	}

	// Secure cookies are set unless the public URL is loopback, which assumes a
	// TLS-terminating proxy in front. Without one the browser drops the session
	// cookie and the user loops between / and /login with nothing in the log to
	// explain it, so say so at startup.
	// An unset URL counts too: it leaves the cookie Secure, which is right
	// behind a TLS proxy and a silent loop on a plain-http LAN address.
	if cfg.SecureCookies && !strings.HasPrefix(cfg.PublicURL, "https://") {
		log.Warn("BACKEND_PUBLIC_URL is not https: the session cookie is marked Secure, so over plain http the browser drops it and sign-in loops",
			"public_url", cfg.PublicURL)
	}

	if cfg.GeneratedSessionSecret {
		log.Warn("BACKEND_SESSION_SECRET is unset: generated a per-process one, so every restart signs everyone out")
	}

	sessions := auth.NewSessionCodec(cfg.SessionSecret, cfg.SecureCookies, cfg.SessionTTL, cfg.OIDCAllowedGroup, cfg.BasePath)
	srv, err := httpapi.New(cfg, oidcService, sessions, rpc, ui, log)
	if err != nil {
		log.Error("ui bundle", "err", err)
		os.Exit(1)
	}

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// The UI polls every 2 s, so a live tab never idles this long; it only
		// reaps the connections of tabs that are gone.
		IdleTimeout: 2 * time.Minute,
	}
	log.Info("listening", "addr", cfg.Addr, "auth", cfg.AuthMode, "upstream", cfg.RPCUpstream)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Error("serve", "err", err)
		os.Exit(1)
	}
}

// healthcheck probes the local listener. It only reports that this process is
// serving; the daemon upstream is deliberately not probed, so a daemon restart
// does not mark the UI unhealthy.
func healthcheck() int {
	addr := os.Getenv("BACKEND_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	// Probe the app's own mount point: under a base path nothing is served at
	// "/", so probing that reports every prefixed deployment as unhealthy and
	// the reverse proxy drops it from routing.
	// Only the path is needed. A full config.Load() here would also mint a
	// throwaway session secret on every probe.
	base := config.BasePathOf(os.Getenv("BACKEND_PUBLIC_URL"))
	client := &http.Client{
		Timeout: 4 * time.Second,
		// A redirect is a healthy answer (signed-out form mode sends / to
		// /login); following it would turn that into a needless second request.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Get("http://" + addr + base + "/") //nolint:gosec // the container's own healthcheck, probing the address this process was configured to listen on
	if err != nil {
		return 1
	}
	defer func() { _ = resp.Body.Close() }()
	// 2xx and 3xx are both healthy: signed-out form mode answers "/" with a
	// redirect to the login page. A 4xx is not -- in particular a 404 means the
	// app is not mounted where it thinks it is, which is the misrouting this
	// probe exists to catch.
	if resp.StatusCode >= 400 {
		return 1
	}
	return 0
}

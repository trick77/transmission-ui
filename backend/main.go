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
	if cfg.SecureCookies && cfg.PublicURL != "" && !strings.HasPrefix(cfg.PublicURL, "https://") {
		log.Warn("BACKEND_PUBLIC_URL is not https: the session cookie is marked Secure and the browser will drop it, so sign-in will loop",
			"public_url", cfg.PublicURL)
	}

	if cfg.GeneratedSessionSecret {
		log.Warn("BACKEND_SESSION_SECRET is unset: generated a per-process one, so every restart signs everyone out")
	}

	sessions := auth.NewSessionCodec(cfg.SessionSecret, cfg.SecureCookies, cfg.SessionTTL, cfg.OIDCAllowedGroup, cfg.BasePath)
	srv := httpapi.New(cfg, oidcService, sessions, rpc, ui, log)

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
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
	client := &http.Client{Timeout: 4 * time.Second}
	resp, err := client.Get("http://" + addr + "/")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

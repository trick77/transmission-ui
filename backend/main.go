// transmission-ui backend: serves the built UI, terminates OIDC against
// Authelia, and proxies RPC to the daemon with its basic auth attached.
package main

import (
	"context"
	"embed"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"time"

	"github.com/trick77/ship/kit/auth"
	"github.com/trick77/ship/kit/httpx"
	"github.com/trick77/ship/kit/logging"
	"github.com/trick77/ship/kit/version"
	"github.com/trick77/transmission-ui/backend/internal/config"
	"github.com/trick77/transmission-ui/backend/internal/httpapi"
	"github.com/trick77/transmission-ui/backend/internal/proxy"
)

// make fe-build and the Containerfile put the Vite build here before `go build`.
//
//go:embed all:dist
var distFS embed.FS

func main() {
	// The runtime image is distroless: no shell, no wget, so the container
	// healthcheck re-executes this binary instead.
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		os.Exit(healthcheck())
	}
	if err := run(); err != nil {
		slog.Error("startup", logging.Err(err))
		os.Exit(1)
	}
}

func run() error {
	cfg, cfgErr := config.Load()
	// Logging first, so the config faults go out in the configured shape; a bad LOG_LEVEL joins them, so every
	// fault is listed at once.
	log, err := logging.Setup(logging.Options{Level: os.Getenv("LOG_LEVEL")})
	if err != nil {
		return errors.Join(err, cfgErr)
	}
	if cfgErr != nil {
		return cfgErr
	}
	ui, err := fs.Sub(distFS, "dist")
	if err != nil {
		return err
	}
	pc := proxy.Config{Upstream: cfg.RPCUpstream, User: cfg.RPCUser, Pass: cfg.RPCPass, Log: log}
	rpc, err := proxy.New(pc)
	if err != nil {
		return err
	}
	ready, err := proxy.Ready(pc)
	if err != nil {
		return err
	}

	var oidc httpapi.OIDC
	if cfg.AuthMode == config.AuthModeOIDC {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if oidc, err = auth.NewOIDC(ctx, httpapi.OIDCConfig(cfg)); err != nil {
			return err
		}
	}
	if cfg.GeneratedSessionSecret {
		log.Warn("BACKEND_SESSION_SECRET is unset: generated a per-process one, so every restart signs everyone out")
	}
	sessions, err := httpapi.NewSessions(cfg)
	if err != nil {
		return err
	}
	srv, err := httpapi.New(cfg, oidc, sessions, rpc, ui, log, httpx.Check{Name: "transmission", Run: ready})
	if err != nil {
		return err
	}

	log.Info("listening", "addr", cfg.Addr, "version", version.String(), "auth", cfg.AuthMode, "upstream", cfg.RPCUpstream)
	return httpx.Serve(context.Background(), httpx.NewServer(cfg.Addr, srv.Handler()), 10*time.Second)
}

// healthcheck probes the local listener's liveness route. The daemon upstream
// is deliberately not probed (that is /readyz), so a daemon restart does not
// mark the UI unhealthy. Only the address and the mount point are read: a full
// config.Load() here would fail on every unset secret the probe never needs.
func healthcheck() int {
	addr := os.Getenv("BACKEND_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	// Under a base path the probe routes live under it too, so probing the
	// root would report every prefixed deployment as unhealthy.
	base := config.BasePathOf(os.Getenv("BACKEND_PUBLIC_URL"))
	return httpx.Healthcheck(httpx.LocalURL(addr, base+"/healthz"))
}

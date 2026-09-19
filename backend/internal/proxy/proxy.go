// Reverse proxy for the Transmission RPC endpoint.
//
// The browser never sees the daemon's credentials: the UI calls /transmission/rpc
// on this origin with its session cookie, and the proxy attaches the daemon's
// basic auth on the way out. httputil.ReverseProxy passes the
// X-Transmission-Session-Id header and the 409 handshake through untouched,
// which is what ui/src/rpc/client.ts expects.
package proxy

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
)

// Config describes the upstream daemon.
type Config struct {
	Upstream string // e.g. http://transmission:9091
	User     string
	Pass     string
}

// New returns a handler proxying to the daemon's RPC endpoint.
func New(cfg Config) (http.Handler, error) {
	target, err := url.Parse(cfg.Upstream)
	if err != nil {
		return nil, fmt.Errorf("parse upstream %q: %w", cfg.Upstream, err)
	}
	if target.Scheme == "" || target.Host == "" {
		return nil, fmt.Errorf("upstream %q needs a scheme and host", cfg.Upstream)
	}

	rp := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			// SetURL joins paths; the daemon serves RPC at a fixed path and the
			// inbound path is already /transmission/rpc, so pin it explicitly
			// rather than depending on how the upstream URL was written.
			r.Out.URL.Path = "/transmission/rpc"
			r.Out.Host = r.In.Host
			// Whatever the browser sent, the daemon gets our credentials. This
			// also strips any Authorization header a client tried to smuggle in.
			r.Out.Header.Del("Authorization")
			if cfg.User != "" {
				r.Out.SetBasicAuth(cfg.User, cfg.Pass)
			}
			// The session cookie is ours, not the daemon's.
			r.Out.Header.Del("Cookie")
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			http.Error(w, "upstream unavailable", http.StatusBadGateway)
		},
	}
	return rp, nil
}

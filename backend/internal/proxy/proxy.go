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
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
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
		// A 401 from the daemon means OUR credentials are wrong, not the
		// visitor's. Forwarding it verbatim would hand the browser a
		// WWW-Authenticate header (it is not hop-by-hop, so ReverseProxy copies
		// it), popping the native basic-auth dialog this whole backend exists to
		// remove -- and the UI would read the 401 as a dead session and loop
		// through sign-in forever. Report it as the upstream misconfig it is.
		ModifyResponse: func(resp *http.Response) error {
			if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
				// 401 is bad credentials; 403 is the daemon's rpc-whitelist,
				// which defaults to 127.0.0.1 and so rejects this backend as
				// soon as it runs in its own container. Naming the wrong one
				// sends the operator to the wrong setting.
				if resp.StatusCode == http.StatusForbidden {
					log.Printf("transmission refused the RPC connection (403); its rpc-whitelist likely does not include this container's address")
				} else {
					log.Printf("transmission rejected our RPC credentials (401); check TM_USER/TM_PASS")
				}
				resp.Header.Del("WWW-Authenticate")
				_ = resp.Body.Close()
				resp.StatusCode = http.StatusBadGateway
				resp.Status = "502 Bad Gateway"
				resp.Body = io.NopCloser(strings.NewReader("upstream refused the request"))
				resp.ContentLength = -1
				resp.Header.Set("Content-Type", "text/plain; charset=utf-8")
				resp.Header.Del("Content-Length")
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "upstream unavailable", http.StatusBadGateway)
		},
	}
	return rp, nil
}

// Reverse proxy for the Transmission RPC endpoint.
//
// The browser never sees the daemon's credentials: the UI calls /transmission/rpc
// on this origin with its session cookie, and the proxy attaches the daemon's
// basic auth on the way out. httputil.ReverseProxy passes the
// X-Transmission-Session-Id header and the 409 handshake through untouched,
// which is what ui/src/rpc/client.ts expects.
package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"

	"github.com/trick77/ship/kit/httpx"
	"github.com/trick77/ship/kit/logging"
)

// rpcPath is where the daemon serves RPC, whatever the upstream URL's path.
const rpcPath = "/transmission/rpc"

// StatusClientClosed is nginx's "client closed request": no client sees it,
// only the access log.
const StatusClientClosed = 499

// Config describes the upstream daemon.
type Config struct {
	Upstream string // e.g. http://transmission:9091
	User     string
	Pass     string
	Log      *slog.Logger // nil logs to slog.Default()
}

func (cfg Config) target() (*url.URL, error) {
	target, err := url.Parse(cfg.Upstream)
	if err != nil {
		return nil, fmt.Errorf("parse upstream %q: %w", cfg.Upstream, err)
	}
	if target.Scheme == "" || target.Host == "" {
		return nil, fmt.Errorf("upstream %q needs a scheme and host", cfg.Upstream)
	}
	return target, nil
}

// New returns a handler proxying to the daemon's RPC endpoint.
func New(cfg Config) (http.Handler, error) {
	target, err := cfg.target()
	if err != nil {
		return nil, err
	}
	log := cfg.Log
	if log == nil {
		log = slog.Default()
	}

	rp := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			// SetURL joins paths; the daemon serves RPC at a fixed path and the
			// inbound path is already /transmission/rpc, so pin it explicitly
			// rather than depending on how the upstream URL was written.
			r.Out.URL.Path = rpcPath
			r.Out.Host = r.In.Host
			// Whatever the browser sent, the daemon gets our credentials. This
			// also strips any Authorization header a client tried to smuggle in.
			r.Out.Header.Del("Authorization")
			r.Out.SetBasicAuth(cfg.User, cfg.Pass)
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
			if err := refusal(resp.StatusCode); err != nil {
				log.ErrorContext(resp.Request.Context(), "transmission refused the RPC request", logging.Err(err))
				resp.Header.Del("WWW-Authenticate")
				_ = resp.Body.Close()
				// No ResponseWriter here, so httpx.WriteError's body by hand.
				body, _ := json.Marshal(map[string]string{"error": "upstream refused the request"})
				resp.StatusCode = http.StatusBadGateway
				resp.Status = "502 Bad Gateway"
				resp.Body = io.NopCloser(bytes.NewReader(body))
				resp.ContentLength = int64(len(body))
				resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
				resp.Header.Set("Content-Type", "application/json")
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			// The browser left (reload, closed tab): the daemon is fine and
			// nobody reads the answer. nginx's 499 keeps it out of the 5xx
			// the access log reports as errors.
			if errors.Is(err, context.Canceled) && r.Context().Err() != nil {
				w.WriteHeader(StatusClientClosed)
				return
			}
			// Refused, unresolvable, timed out: the one place the reason exists.
			log.ErrorContext(r.Context(), "transmission is unreachable", "upstream", cfg.Upstream, logging.Err(err))
			httpx.WriteError(w, http.StatusBadGateway, "upstream unavailable")
		},
	}
	return rp, nil
}

// refusal names a daemon answer that means this backend is misconfigured. 401
// is bad credentials; 403 is the daemon's rpc-whitelist, which defaults to
// 127.0.0.1 and so rejects this backend as soon as it runs in its own
// container. Naming the wrong one sends the operator to the wrong setting.
func refusal(status int) error {
	switch status {
	case http.StatusUnauthorized:
		return errors.New("daemon rejected the RPC credentials (401): check TRANSMISSION_USER/TRANSMISSION_PASSWORD")
	case http.StatusForbidden:
		return errors.New("daemon refused the connection (403): its rpc-whitelist likely does not include this container's address")
	}
	return nil
}

// Ready is the readiness check: the daemon answers RPC and accepts our
// credentials: the 409 session-id handshake (what an unauthenticated-session
// POST gets) or a 2xx. Anything else, a 404 or 405 included, is not a
// Transmission RPC endpoint, so the UI cannot work against it.
func Ready(cfg Config) (func(context.Context) error, error) {
	target, err := cfg.target()
	if err != nil {
		return nil, err
	}
	endpoint := url.URL{Scheme: target.Scheme, Host: target.Host, Path: rpcPath}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return func(ctx context.Context) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), nil)
		if err != nil {
			return err
		}
		req.SetBasicAuth(cfg.User, cfg.Pass)
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if err := refusal(resp.StatusCode); err != nil {
			return err
		}
		if resp.StatusCode != http.StatusConflict && (resp.StatusCode < 200 || resp.StatusCode > 299) {
			return fmt.Errorf("daemon answered %d, not a Transmission RPC endpoint", resp.StatusCode)
		}
		return nil
	}, nil
}

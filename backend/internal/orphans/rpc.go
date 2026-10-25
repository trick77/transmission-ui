package orphans

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
)

// rpcClient asks the daemon what it owns. It is the backend's own client, not
// the browser's proxy: the scan and every delete must judge by what the daemon
// says right now, never by anything a browser sends.
type rpcClient struct {
	endpoint string
	user     string
	pass     string
	http     *http.Client

	mu  sync.Mutex
	sid string // X-Transmission-Session-Id from the last 409
}

func newRPCClient(upstream, user, pass string) (*rpcClient, error) {
	u, err := url.Parse(upstream)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("upstream %q needs a scheme and host", upstream)
	}
	end := url.URL{Scheme: u.Scheme, Host: u.Host, Path: "/transmission/rpc"}
	return &rpcClient{endpoint: end.String(), user: user, pass: pass, http: &http.Client{}}, nil
}

// session is the part of session_get the claimed set needs.
type session struct {
	DownloadDir   string `json:"download_dir"`
	IncompleteDir string `json:"incomplete_dir"`
	ConfigDir     string `json:"config_dir"`
}

// torrent is the part of torrent_get the claimed set needs.
type torrent struct {
	ID          int    `json:"id"`
	Name        string `json:"name"`
	HashString  string `json:"hash_string"`
	DownloadDir string `json:"download_dir"`
	Files       []struct {
		Name   string `json:"name"`
		Length int64  `json:"length"`
	} `json:"files"`
}

func (c *rpcClient) session(ctx context.Context) (session, error) {
	var s session
	err := c.call(ctx, "session_get", map[string]any{
		"fields": []string{"download_dir", "incomplete_dir", "config_dir"},
	}, &s)
	return s, err
}

// identities is the cheap torrent_get: no file lists. A delete compares it
// with the one its claims were built from, and builds them again on any change.
func (c *rpcClient) identities(ctx context.Context) ([]torrent, error) {
	var out struct {
		Torrents []torrent `json:"torrents"`
	}
	err := c.call(ctx, "torrent_get", map[string]any{
		"fields": []string{"id", "name", "hash_string", "download_dir"},
	}, &out)
	return out.Torrents, err
}

func (c *rpcClient) torrents(ctx context.Context) ([]torrent, error) {
	var out struct {
		Torrents []torrent `json:"torrents"`
	}
	err := c.call(ctx, "torrent_get", map[string]any{
		"fields": []string{"id", "name", "hash_string", "download_dir", "files"},
	}, &out)
	return out.Torrents, err
}

func (c *rpcClient) call(ctx context.Context, method string, params, out any) error {
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method, "params": params, "id": 1})
	if err != nil {
		return err
	}
	// One retry, for the session-id handshake: the first call after a daemon
	// restart always gets a 409 carrying the id to use.
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		req.SetBasicAuth(c.user, c.pass)
		c.mu.Lock()
		if c.sid != "" {
			req.Header.Set("X-Transmission-Session-Id", c.sid)
		}
		c.mu.Unlock()
		resp, err := c.http.Do(req)
		if err != nil {
			return fmt.Errorf("transmission is unreachable: %w", err)
		}
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 256<<20))
		_ = resp.Body.Close()
		if err != nil {
			return err
		}
		if resp.StatusCode == http.StatusConflict && attempt == 0 {
			c.mu.Lock()
			c.sid = resp.Header.Get("X-Transmission-Session-Id")
			c.mu.Unlock()
			continue
		}
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("transmission answered %s to %s", resp.Status, method)
		}
		var env struct {
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			return fmt.Errorf("%s: %w", method, err)
		}
		if env.Error != nil {
			return fmt.Errorf("%s: %s", method, env.Error.Message)
		}
		if len(env.Result) == 0 {
			return errors.New(method + ": empty result")
		}
		return json.Unmarshal(env.Result, out)
	}
}

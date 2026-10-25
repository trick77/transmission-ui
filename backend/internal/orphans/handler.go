package orphans

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/trick77/ship/kit/auth"
	"github.com/trick77/ship/kit/httpx"
	"github.com/trick77/ship/kit/logging"
)

// maxBody bounds the small JSON bodies the routes accept.
const maxBody = 4 << 10

// Handler serves the orphan routes at /api/orphans; the caller strips its base
// path, and guards and cross-origin-checks the routes.
func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/orphans", s.handleStatus)
	mux.HandleFunc("POST /api/orphans/scan", s.handleScan)
	mux.HandleFunc("POST /api/orphans/keep", s.handleKeep)
	mux.HandleFunc("POST /api/orphans/unkeep", s.handleUnkeep)
	mux.HandleFunc("POST /api/orphans/forget", s.handleForget)
	mux.HandleFunc("POST /api/orphans/delete", s.handleDelete)
	return mux
}

// Disabled answers every orphan route when the finder is not set up, so a GET
// does not fall through to the app shell and look like a 200.
func Disabled() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteError(w, http.StatusNotFound, "the orphan finder is not set up: BACKEND_DATA_ROOTS and BACKEND_DAEMON_CONFIG are unset")
	})
}

func (s *Service) handleStatus(w http.ResponseWriter, r *http.Request) {
	st, err := s.Status()
	if err != nil {
		httpx.ServerError(w, r, err, "cannot read the remembered Keeps")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, st)
}

// handleScan streams NDJSON: progress lines while it walks, then one result or
// error line. The status is 200 once streaming starts, so failures after that
// travel as {"error"} lines. Closing the request stops the walk.
func (s *Service) handleScan(w http.ResponseWriter, r *http.Request) {
	rc := http.NewResponseController(w)
	started := false
	enc := json.NewEncoder(w)
	start := func() {
		if started {
			return
		}
		started = true
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("Cache-Control", "no-store")
		// nginx buffers responses by default, which would hold every progress
		// line back until the scan ends.
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)
	}
	line := func(v any) {
		start()
		_ = enc.Encode(v)
		_ = rc.Flush()
	}
	res, err := s.Scan(r.Context(), func(n int, cur string) {
		line(map[string]any{"progress": map[string]any{"looked": n, "path": cur}})
	})
	switch {
	case errors.Is(err, ErrBusy) && !started:
		httpx.WriteError(w, http.StatusLocked, err.Error())
	case errors.Is(err, context.Canceled):
		// The browser pressed Stop and is not listening.
	case err != nil:
		s.log.WarnContext(r.Context(), "orphan scan failed", logging.Err(err))
		line(map[string]string{"error": err.Error()})
	default:
		line(map[string]any{"result": res})
	}
}

type entryRef struct {
	ScanID string `json:"scan_id"`
	ID     string `json:"id"`
}

func (s *Service) handleKeep(w http.ResponseWriter, r *http.Request) {
	var ref entryRef
	if !httpx.DecodeJSON(w, r, &ref, maxBody) {
		return
	}
	if err := s.Keep(ref.ScanID, ref.ID); err != nil {
		s.writeOpError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleUnkeep takes one Keep back, a decision undone in the review.
func (s *Service) handleUnkeep(w http.ResponseWriter, r *http.Request) {
	var ref entryRef
	if !httpx.DecodeJSON(w, r, &ref, maxBody) {
		return
	}
	if err := s.Unkeep(ref.ScanID, ref.ID); err != nil {
		s.writeOpError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleForget drops every Keep: Settings' Forget all. Its own route, so that a
// lost request body can never turn one undo into forgetting everything.
func (s *Service) handleForget(w http.ResponseWriter, r *http.Request) {
	if err := s.ForgetKept(); err != nil {
		s.writeOpError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Service) handleDelete(w http.ResponseWriter, r *http.Request) {
	var ref entryRef
	if !httpx.DecodeJSON(w, r, &ref, maxBody) {
		return
	}
	who := ""
	if c, ok := auth.FromContext(r.Context()); ok {
		who = c.PreferredUsername
		if who == "" {
			who = c.Subject
		}
	}
	if err := s.Delete(r.Context(), ref.ScanID, ref.ID, who); err != nil {
		s.writeOpError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// writeOpError: 409 when the recheck kept the entry, 423 when another scan or
// delete runs (nothing was checked, try again), 410 for an expired scan, 500
// with the reason otherwise. The UI shows the message on the row, so it is the
// plain reason, e.g. "permission denied".
func (s *Service) writeOpError(w http.ResponseWriter, r *http.Request, err error) {
	var kept *KeptError
	switch {
	case errors.As(err, &kept):
		httpx.WriteError(w, http.StatusConflict, err.Error())
	case errors.Is(err, ErrBusy):
		httpx.WriteError(w, http.StatusLocked, err.Error())
	case errors.Is(err, ErrExpired):
		httpx.WriteError(w, http.StatusGone, err.Error())
	default:
		s.log.WarnContext(r.Context(), "orphan operation failed", logging.Err(err))
		httpx.WriteError(w, http.StatusInternalServerError, plainReason(err))
	}
}

// plainReason is the innermost message: "permission denied" rather than the
// full "unlinkat /data/...: permission denied".
func plainReason(err error) string {
	for {
		u := errors.Unwrap(err)
		if u == nil {
			return err.Error()
		}
		err = u
	}
}

package orphans

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trick77/ship/kit/auth"
)

func do(t *testing.T, h http.Handler, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(auth.NewContext(r.Context(), auth.Claims{Subject: "sub-1", PreferredUsername: "jan"}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// scanOver runs a scan through the handler and returns its result line.
func scanOver(t *testing.T, h http.Handler) Result {
	t.Helper()
	w := do(t, h, http.MethodPost, "/api/orphans/scan", "")
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "application/x-ndjson" {
		t.Fatalf("scan: %d %s", w.Code, w.Header().Get("Content-Type"))
	}
	var last struct {
		Result *Result `json:"result"`
		Error  string  `json:"error"`
	}
	sc := bufio.NewScanner(w.Body)
	for sc.Scan() {
		last.Result, last.Error = nil, ""
		if err := json.Unmarshal(sc.Bytes(), &last); err != nil {
			t.Fatal(err)
		}
	}
	if last.Result == nil {
		t.Fatalf("no result line, error %q", last.Error)
	}
	return *last.Result
}

func TestHandlerFlow(t *testing.T) {
	f := newFixture(t)
	f.file(f.data, "a/1.bin", 1)
	f.file(f.data, "b/1.bin", 1)
	h := f.svc.Handler()

	w := do(t, h, http.MethodGet, "/api/orphans", "")
	var st Status
	if err := json.Unmarshal(w.Body.Bytes(), &st); err != nil || w.Code != http.StatusOK || len(st.Roots) != 2 {
		t.Fatalf("status: %d %s", w.Code, w.Body)
	}

	r := scanOver(t, h)
	if len(r.Entries) != 2 {
		t.Fatalf("entries: %+v", r.Entries)
	}
	ref := func(id string) string { return fmt.Sprintf(`{"scan_id":%q,"id":%q}`, r.ID, id) }

	if w := do(t, h, http.MethodPost, "/api/orphans/keep", ref(r.Entries[0].ID)); w.Code != http.StatusOK {
		t.Fatalf("keep: %d %s", w.Code, w.Body)
	}
	if w := do(t, h, http.MethodPost, "/api/orphans/delete", ref(r.Entries[1].ID)); w.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", w.Code, w.Body)
	}
	if w := do(t, h, http.MethodPost, "/api/orphans/delete", `{"scan_id":"nope","id":"e1"}`); w.Code != http.StatusGone {
		t.Fatalf("expired: %d", w.Code)
	}
	if w := do(t, h, http.MethodPost, "/api/orphans/keep", `{"scan_id":"nope","id":"e1"}`); w.Code != http.StatusGone {
		t.Fatalf("keep expired: %d", w.Code)
	}
	if w := do(t, h, http.MethodPost, "/api/orphans/delete", `not json`); w.Code != http.StatusBadRequest {
		t.Fatalf("bad body: %d", w.Code)
	}
	if w := do(t, h, http.MethodPost, "/api/orphans/keep", `not json`); w.Code != http.StatusBadRequest {
		t.Fatalf("bad keep body: %d", w.Code)
	}
	// Taking one Keep back forgets that one only.
	if w := do(t, h, http.MethodDelete, "/api/orphans/keep", ref(r.Entries[0].ID)); w.Code != http.StatusOK {
		t.Fatalf("unkeep: %d %s", w.Code, w.Body)
	}
	if st, _ := f.svc.Status(); len(st.Kept) != 0 {
		t.Fatalf("unkeep left %+v", st.Kept)
	}
	if w := do(t, h, http.MethodDelete, "/api/orphans/keep", `{"scan_id":"nope","id":"e1"}`); w.Code != http.StatusGone {
		t.Fatalf("unkeep expired: %d", w.Code)
	}
	if w := do(t, h, http.MethodDelete, "/api/orphans/keep", `not json`); w.Code != http.StatusBadRequest {
		t.Fatalf("unkeep bad body: %d", w.Code)
	}
	if w := do(t, h, http.MethodDelete, "/api/orphans/keep", ""); w.Code != http.StatusOK {
		t.Fatalf("forget: %d", w.Code)
	}

	// Busy before streaming starts is a plain 409.
	f.svc.opMu.Lock()
	if w := do(t, h, http.MethodPost, "/api/orphans/scan", ""); w.Code != http.StatusConflict {
		t.Fatalf("busy scan: %d", w.Code)
	}
	if w := do(t, h, http.MethodPost, "/api/orphans/delete", ref("e1")); w.Code != http.StatusConflict {
		t.Fatalf("busy delete: %d", w.Code)
	}
	f.svc.opMu.Unlock()

	// A failure travels as an error line.
	f.daemon.fail = "boom"
	w = do(t, h, http.MethodPost, "/api/orphans/scan", "")
	if !strings.Contains(w.Body.String(), `"error":"session_get: boom"`) {
		t.Fatalf("error line: %s", w.Body)
	}
}

func TestHandlerServerErrors(t *testing.T) {
	f := newFixture(t)
	h := f.svc.Handler()
	// Unreadable Keep list: status and forget report it.
	must(t, os.WriteFile(filepath.Join(f.cfg, keepFile), []byte("{"), 0o644))
	if w := do(t, h, http.MethodGet, "/api/orphans", ""); w.Code != http.StatusInternalServerError {
		t.Fatalf("status with a broken keep file: %d", w.Code)
	}
	if _, err := f.svc.Scan(t.Context(), nil); err == nil {
		t.Fatal("scan with a broken keep file should fail")
	}
	must(t, os.Remove(filepath.Join(f.cfg, keepFile)))
	must(t, os.Mkdir(filepath.Join(f.cfg, keepFile), 0o755))
	must(t, os.WriteFile(filepath.Join(f.cfg, keepFile, "x"), nil, 0o644))
	if w := do(t, h, http.MethodDelete, "/api/orphans/keep", ""); w.Code != http.StatusInternalServerError {
		t.Fatalf("forget failing: %d %s", w.Code, w.Body)
	}
}

func TestDisabled(t *testing.T) {
	w := httptest.NewRecorder()
	Disabled().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/orphans", nil))
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "BACKEND_DATA_ROOTS") {
		t.Fatalf("disabled: %d %s", w.Code, w.Body)
	}
}

func TestPlainReason(t *testing.T) {
	err := &fs.PathError{Op: "unlinkat", Path: "/data/x", Err: errors.New("permission denied")}
	if got := plainReason(fmt.Errorf("delete: %w", err)); got != "permission denied" {
		t.Fatalf("plain reason: %q", got)
	}
}

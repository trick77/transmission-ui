package orphans

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/trick77/transmission-ui/backend/internal/config"
)

// fakeDaemon is enough of transmission-daemon for the orphan finder: the 409
// handshake, basic auth, session_get and torrent_get.
type fakeDaemon struct {
	mu       sync.Mutex
	session  session
	torrents []torrent
	calls    int
	fail     string // when set, every call answers a JSON-RPC error
}

func (d *fakeDaemon) set(ts ...torrent) {
	d.mu.Lock()
	d.torrents = ts
	d.mu.Unlock()
}

func (d *fakeDaemon) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if u, p, ok := r.BasicAuth(); !ok || u != "u" || p != "p" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if r.Header.Get("X-Transmission-Session-Id") != "sid" {
		w.Header().Set("X-Transmission-Session-Id", "sid")
		w.WriteHeader(http.StatusConflict)
		return
	}
	var req struct {
		Method string `json:"method"`
		ID     int    `json:"id"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	d.mu.Lock()
	defer d.mu.Unlock()
	d.calls++
	if d.fail != "" {
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": 1, "message": d.fail}})
		return
	}
	var result any
	switch req.Method {
	case "session_get":
		result = d.session
	case "torrent_get":
		result = map[string]any{"torrents": d.torrents}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
}

func tor(name, dir string, files ...string) torrent {
	t := torrent{Name: name, DownloadDir: dir, HashString: hashOf(name)}
	for _, f := range files {
		t.Files = append(t.Files, struct {
			Name   string `json:"name"`
			Length int64  `json:"length"`
		}{Name: f})
	}
	return t
}

// hashOf is a stable fake info hash per name.
func hashOf(name string) string {
	h := uint64(14695981039346656037)
	for _, c := range []byte(name) {
		h = (h ^ uint64(c)) * 1099511628211
	}
	s := ""
	for len(s) < 40 {
		s += strings.Repeat("0", 0) + hexDigits(h)
		h = h*31 + 7
	}
	return s[:40]
}

func hexDigits(v uint64) string {
	const d = "0123456789abcdef"
	b := make([]byte, 16)
	for i := 15; i >= 0; i-- {
		b[i] = d[v&15]
		v >>= 4
	}
	return string(b)
}

type fixture struct {
	t      *testing.T
	data   string // root, same path for daemon and container
	inc    string // incomplete root
	cfg    string // daemon config folder
	daemon *fakeDaemon
	svc    *Service
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	base := t.TempDir()
	f := &fixture{t: t, data: filepath.Join(base, "data"), inc: filepath.Join(base, "inc"), cfg: filepath.Join(base, "config")}
	for _, d := range []string{f.data, f.inc, f.cfg, filepath.Join(f.cfg, "torrents"), filepath.Join(f.cfg, "resume")} {
		must(t, os.MkdirAll(d, 0o755))
	}
	f.daemon = &fakeDaemon{session: session{DownloadDir: f.data, IncompleteDir: f.inc, IncompleteDirEnabled: true, ConfigDir: f.cfg}}
	srv := httptest.NewServer(f.daemon)
	t.Cleanup(srv.Close)
	svc, err := New(Options{
		Roots:        []config.Mount{{Daemon: f.data, Local: f.data}, {Daemon: f.inc, Local: f.inc}},
		DaemonConfig: config.Mount{Daemon: f.cfg, Local: f.cfg},
		Upstream:     srv.URL, User: "u", Pass: "p",
	})
	must(t, err)
	f.svc = svc
	return f
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// file writes rel (under dir) with n bytes and an mtime an hour back, so it is
// not "recent" unless a test says so.
func (f *fixture) file(dir, rel string, n int) string {
	f.t.Helper()
	p := filepath.Join(dir, rel)
	must(f.t, os.MkdirAll(filepath.Dir(p), 0o755))
	must(f.t, os.WriteFile(p, make([]byte, n), 0o644))
	old := time.Now().Add(-time.Hour)
	must(f.t, os.Chtimes(p, old, old))
	return p
}

func (f *fixture) scan() *Result {
	f.t.Helper()
	r, err := f.svc.Scan(context.Background(), nil)
	must(f.t, err)
	return r
}

func paths(r *Result) []string {
	var out []string
	for _, e := range r.Entries {
		out = append(out, e.Path)
	}
	return out
}

func find(r *Result, p string) *Entry {
	for _, e := range r.Entries {
		if e.Path == p {
			return e
		}
	}
	return nil
}

func TestScanOffersOnlyWhatNobodyOwns(t *testing.T) {
	f := newFixture(t)
	f.file(f.data, "Live/a.mkv", 10)
	f.file(f.data, "Live/sample/extra.mkv", 5)           // stray inside a live torrent
	f.file(f.data, "Gone (1957)/movie.mkv", 100)         // a removed torrent's folder
	f.file(f.data, "Gone (1957)/subs/en.srt", 1)         //   ... collapsed into one entry
	f.file(f.data, "single.iso", 7)                      // owned single-file torrent
	f.file(f.data, "stray.iso", 3)                       // unowned file at the root
	f.file(f.inc, "Half/b.mkv.part", 4)                  // owned, mid-download in incomplete
	f.file(f.inc, "abandoned.iso.part", 9)               // nobody's partial
	f.file(f.data, "movies/Kept/k.mkv", 2)               // owned, under a category folder
	f.file(f.data, "movies/loose.txt", 1)                // stray in a category folder: not "inside"
	f.file(f.data, "lost+found/x", 1)                    // housekeeping is never listed
	must(t, os.MkdirAll(filepath.Join(f.data, "empty-dir"), 0o755))
	f.daemon.set(
		tor("Live", f.data, "Live/a.mkv"),
		tor("single.iso", f.data, "single.iso"),
		tor("Half", f.data, "Half/b.mkv"),
		tor("Kept", filepath.Join(f.data, "movies"), "Kept/k.mkv"),
	)
	r := f.scan()
	want := []string{
		filepath.Join(f.data, "Gone (1957)"),
		filepath.Join(f.data, "Live/sample"),
		filepath.Join(f.data, "stray.iso"),
		filepath.Join(f.data, "movies/loose.txt"),
		filepath.Join(f.data, "empty-dir"),
		filepath.Join(f.inc, "abandoned.iso.part"),
	}
	got := paths(r)
	slices.Sort(want)
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Fatalf("entries\n got %v\nwant %v", got, want)
	}
	gone := find(r, filepath.Join(f.data, "Gone (1957)"))
	if gone.Kind != "dir" || gone.Files != 2 || gone.Size != 101 || gone.Types["video"] != 1 || gone.Types["subtitle"] != 1 {
		t.Fatalf("collapsed folder: %+v", gone)
	}
	if len(gone.Children) != 2 || gone.Children[0].Name != "movie.mkv" {
		t.Fatalf("children biggest first: %+v", gone.Children)
	}
	if e := find(r, filepath.Join(f.data, "Live/sample")); e.Inside != "Live" || !slices.Contains(e.Flags, "inside") {
		t.Fatalf("stray inside a torrent: %+v", e)
	}
	if e := find(r, filepath.Join(f.data, "movies/loose.txt")); e.Inside != "" {
		t.Fatalf("a category folder is nobody's: %+v", e)
	}
	if e := find(r, filepath.Join(f.data, "empty-dir")); e.Kind != "empty" {
		t.Fatalf("empty folder: %+v", e)
	}
	if e := find(r, filepath.Join(f.inc, "abandoned.iso.part")); !slices.Contains(e.Flags, "partial") {
		t.Fatalf("partial: %+v", e)
	}
	// Grouped by root in configured order, biggest first within.
	if r.Entries[0].Group != f.data || r.Entries[len(r.Entries)-1].Group != f.inc || r.Entries[0].Size < r.Entries[1].Size {
		t.Fatalf("order: %v", got)
	}
	if r.Looked == 0 || r.ID == "" {
		t.Fatalf("result meta: %+v", r)
	}
}

func TestDaemonFoldersAreNeverOrphans(t *testing.T) {
	f := newFixture(t)
	// The incomplete folder lives inside the data root and holds nothing right now.
	inc := filepath.Join(f.data, ".incomplete")
	must(t, os.MkdirAll(inc, 0o755))
	f.daemon.session.IncompleteDir = inc
	if r := f.scan(); len(r.Entries) != 0 {
		t.Fatalf("the daemon's own empty folder was offered: %v", paths(r))
	}
}

func TestMagnetWithoutMetadataClaimsItsWholeFolder(t *testing.T) {
	f := newFixture(t)
	f.file(f.data, "Fetching/part1.bin", 1)
	f.daemon.set(tor("Fetching", f.data))
	if r := f.scan(); len(r.Entries) != 0 {
		t.Fatalf("a torrent without a file list still owns its folder: %v", paths(r))
	}
}

func TestNamesCompareAfterNFC(t *testing.T) {
	f := newFixture(t)
	nfd := "Café"                 // as a Mac client writes it
	f.file(f.data, nfd+"/x.mkv", 1)      // on disk: NFD
	f.daemon.set(tor("Café", f.data, "Café/x.mkv")) // daemon: NFC
	if r := f.scan(); len(r.Entries) != 0 {
		t.Fatalf("NFD on disk vs NFC in the daemon offered a live file: %v", paths(r))
	}
}

func TestSymlinksAreNotFollowed(t *testing.T) {
	f := newFixture(t)
	outside := t.TempDir()
	f.file(outside, "precious.txt", 1)
	must(t, os.Symlink(outside, filepath.Join(f.data, "link")))
	r := f.scan()
	e := find(r, filepath.Join(f.data, "link"))
	if e == nil || e.Kind != "symlink" {
		t.Fatalf("symlink entry: %v", paths(r))
	}
	must(t, f.svc.Delete(context.Background(), r.ID, e.ID, "me"))
	if _, err := os.Stat(filepath.Join(outside, "precious.txt")); err != nil {
		t.Fatal("deleting a symlink reached its target")
	}
	if _, err := os.Lstat(filepath.Join(f.data, "link")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the link itself should be gone")
	}
}

func TestFlags(t *testing.T) {
	f := newFixture(t)
	a := f.file(f.data, "Linked/a.mkv", 5)
	must(t, os.Link(a, filepath.Join(t.TempDir(), "library-copy.mkv")))
	p := f.file(f.data, "fresh.iso", 1)
	now := time.Now()
	must(t, os.Chtimes(p, now, now))
	f.file(f.data, "elsewhere-name", 1) // a loaded torrent has this name, stored somewhere else
	tf := f.file(f.data, "watch/x.torrent", 0)
	must(t, os.WriteFile(tf, []byte("d4:infod4:name8:arch.isoee"), 0o644))
	f.daemon.set(tor("elsewhere-name", "/srv/other"))
	r := f.scan()
	if e := find(r, filepath.Join(f.data, "Linked")); !slices.Contains(e.Flags, "hardlinked") {
		t.Fatalf("hardlinked: %+v", e)
	}
	if e := find(r, filepath.Join(f.data, "fresh.iso")); !slices.Contains(e.Flags, "recent") {
		t.Fatalf("recent: %+v", e)
	}
	if e := find(r, filepath.Join(f.data, "elsewhere-name")); e.Match != "/srv/other" || !slices.Contains(e.Flags, "match") {
		t.Fatalf("match: %+v", e)
	}
	if e := find(r, filepath.Join(f.data, "watch")); e == nil {
		t.Fatalf("watch folder: %v", paths(r))
	}
	if len(r.Warnings) != 1 || !strings.Contains(r.Warnings[0], "/srv/other") {
		t.Fatalf("warnings: %v", r.Warnings)
	}
}

func TestStrayTorrentFileIsNamed(t *testing.T) {
	f := newFixture(t)
	tf := f.file(f.data, "x.torrent", 0)
	must(t, os.WriteFile(tf, []byte("d4:infod4:name8:arch.iso6:lengthi5eee"), 0o644))
	e := find(f.scan(), tf)
	if e == nil || e.Name != "arch.iso" || !slices.Contains(e.Flags, "torrent") {
		t.Fatalf("stray .torrent: %+v", e)
	}
}

func TestStateFiles(t *testing.T) {
	f := newFixture(t)
	live := hashOf("Live")
	gone := strings.Repeat("ab", 20)
	lone := strings.Repeat("cd", 20)
	tdir, rdir := filepath.Join(f.cfg, "torrents"), filepath.Join(f.cfg, "resume")
	must(t, os.WriteFile(filepath.Join(tdir, live+".torrent"), []byte("d4:infod4:name4:Liveee"), 0o644))
	must(t, os.WriteFile(filepath.Join(tdir, gone+".torrent"), []byte("d4:infod4:name4:Goneee"), 0o644))
	must(t, os.WriteFile(filepath.Join(rdir, gone+".resume"), []byte("d4:name4:Gonee"), 0o644))
	must(t, os.WriteFile(filepath.Join(rdir, lone+".resume"), []byte("d4:name4:Lonee"), 0o644))
	must(t, os.WriteFile(filepath.Join(tdir, "Old Name.0123456789abcdef.magnet"), []byte("magnet:?xt=urn:btih:x&dn=Old+Name"), 0o644))
	must(t, os.WriteFile(filepath.Join(f.cfg, "settings.json"), []byte("{}"), 0o644))
	f.daemon.set(tor("Live", f.data))
	r := f.scan()
	var state []*Entry
	for _, e := range r.Entries {
		if e.Group == StateGroup {
			state = append(state, e)
		}
	}
	if len(state) != 3 {
		t.Fatalf("state entries: %+v", state)
	}
	byHash := map[string]*Entry{}
	for _, e := range state {
		byHash[e.Hash] = e
	}
	if e := byHash[gone]; e == nil || e.Files != 2 || e.Name != "Gone" {
		t.Fatalf("torrent+resume pair: %+v", e)
	}
	if e := byHash[lone]; e == nil || e.Name != "Lone" {
		t.Fatalf("lone resume: %+v", e)
	}
	if e := byHash["0123456789abcdef"]; e == nil || e.Name != "Old Name" {
		t.Fatalf("legacy magnet: %+v", e)
	}
	must(t, f.svc.Delete(context.Background(), r.ID, byHash[gone].ID, "me"))
	for _, p := range []string{filepath.Join(tdir, gone+".torrent"), filepath.Join(rdir, gone+".resume")} {
		if _, err := os.Stat(p); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s should be gone", p)
		}
	}
	if _, err := os.Stat(filepath.Join(tdir, live+".torrent")); err != nil {
		t.Fatal("a loaded torrent's file was touched")
	}
	// Re-added since the scan: refused.
	f.daemon.set(tor("Live", f.data), torrent{Name: "Lone", HashString: lone})
	f.svc.mu.Lock()
	f.svc.claims = nil
	f.svc.mu.Unlock()
	var kept *KeptError
	if err := f.svc.Delete(context.Background(), r.ID, byHash[lone].ID, "me"); !errors.As(err, &kept) {
		t.Fatalf("re-added hash: %v", err)
	}
}

func TestDeleteRechecks(t *testing.T) {
	f := newFixture(t)
	f.file(f.data, "a/1.bin", 1)
	f.file(f.data, "b/1.bin", 1)
	f.file(f.data, "c/1.bin", 1)
	r := f.scan()
	ctx := context.Background()
	a, b, c := find(r, filepath.Join(f.data, "a")), find(r, filepath.Join(f.data, "b")), find(r, filepath.Join(f.data, "c"))

	must(t, f.svc.Delete(ctx, r.ID, a.ID, "me"))
	if _, err := os.Stat(filepath.Join(f.data, "a")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a should be gone")
	}
	// A second delete of the same entry: it left the result.
	if err := f.svc.Delete(ctx, r.ID, a.ID, "me"); err == nil {
		t.Fatal("deleting twice should fail")
	}

	// Claimed by a torrent added since the scan: refused, still on disk.
	f.daemon.set(tor("b", f.data, "b/1.bin"))
	f.svc.mu.Lock()
	f.svc.claims = nil
	f.svc.mu.Unlock()
	var kept *KeptError
	if err := f.svc.Delete(ctx, r.ID, b.ID, "me"); !errors.As(err, &kept) || !strings.Contains(kept.Reason, "now belongs to b") {
		t.Fatalf("claimed since scan: %v", err)
	}
	if _, err := os.Stat(filepath.Join(f.data, "b/1.bin")); err != nil {
		t.Fatal("a claimed file was deleted")
	}

	// Changed since the scan: refused.
	f.file(f.data, "c/2.bin", 1)
	if err := f.svc.Delete(ctx, r.ID, c.ID, "me"); !errors.As(err, &kept) || kept.Reason != "changed since the scan" {
		t.Fatalf("changed since scan: %v", err)
	}

	// Gone already.
	must(t, os.RemoveAll(filepath.Join(f.data, "c")))
	if err := f.svc.Delete(ctx, r.ID, c.ID, "me"); !errors.As(err, &kept) || kept.Reason != "already gone" {
		t.Fatalf("already gone: %v", err)
	}

	if err := f.svc.Delete(ctx, "other-scan", b.ID, "me"); !errors.Is(err, ErrExpired) {
		t.Fatalf("unknown scan: %v", err)
	}
	f.svc.now = func() time.Time { return time.Now().Add(resultTTL + time.Minute) }
	if err := f.svc.Delete(ctx, r.ID, b.ID, "me"); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired scan: %v", err)
	}
}

func TestKeepHidesUntilChanged(t *testing.T) {
	f := newFixture(t)
	f.file(f.data, "keepme/1.bin", 1)
	r := f.scan()
	e := find(r, filepath.Join(f.data, "keepme"))
	must(t, f.svc.Keep(r.ID, e.ID))
	must(t, f.svc.Keep(r.ID, e.ID)) // twice is fine
	r = f.scan()
	if len(r.Entries) != 0 || r.HiddenKept != 1 {
		t.Fatalf("kept should hide: %v hidden=%d", paths(r), r.HiddenKept)
	}
	st, err := f.svc.Status()
	must(t, err)
	if len(st.Kept) != 1 || st.LastScan == 0 || len(st.Roots) != 2 || st.Config != f.cfg {
		t.Fatalf("status: %+v", st)
	}
	f.file(f.data, "keepme/2.bin", 1)
	if r = f.scan(); len(r.Entries) != 1 {
		t.Fatalf("a changed Keep comes back: %v", paths(r))
	}
	must(t, f.svc.ForgetKept())
	must(t, f.svc.ForgetKept()) // nothing left to forget
	if st, _ = f.svc.Status(); len(st.Kept) != 0 {
		t.Fatalf("forget: %+v", st.Kept)
	}
}

func TestScanRefusals(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	f.daemon.session.ConfigDir = "/elsewhere"
	if _, err := f.svc.Scan(ctx, nil); err == nil || !strings.Contains(err.Error(), "BACKEND_DAEMON_CONFIG") {
		t.Fatalf("config dir mismatch: %v", err)
	}
	f.daemon.session.ConfigDir = f.cfg

	// Visible here but not configured: the same storage might be scanned under another name.
	seen := t.TempDir()
	f.daemon.set(tor("x", seen, "x/1"))
	if _, err := f.svc.Scan(ctx, nil); err == nil || !strings.Contains(err.Error(), "BACKEND_DATA_ROOTS") {
		t.Fatalf("visible unscanned folder: %v", err)
	}
	f.daemon.set()

	f.svc.opMu.Lock()
	if _, err := f.svc.Scan(ctx, nil); !errors.Is(err, ErrBusy) {
		t.Fatalf("busy scan: %v", err)
	}
	if err := f.svc.Delete(ctx, "x", "y", "me"); !errors.Is(err, ErrBusy) {
		t.Fatalf("busy delete: %v", err)
	}
	f.svc.opMu.Unlock()

	f.daemon.fail = "boom"
	if _, err := f.svc.Scan(ctx, nil); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("rpc error: %v", err)
	}
	f.daemon.fail = ""

	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := f.svc.Scan(cctx, nil); err == nil {
		t.Fatal("a cancelled scan should stop")
	}
}

func TestScanStopsMidWalk(t *testing.T) {
	f := newFixture(t)
	for i := range 50 {
		f.file(f.data, "d/"+strings.Repeat("x", i+1), 1)
	}
	f.daemon.set(tor("d", f.data, "d/x"))
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	f.svc.now = func() time.Time { calls++; return time.Unix(int64(calls), 0) } // every path reports progress
	_, err := f.svc.Scan(ctx, func(int, string) { cancel() })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("stop mid-walk: %v", err)
	}
}

func TestNewChecksFolders(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "f")
	must(t, os.WriteFile(file, nil, 0o644))
	if _, err := New(Options{Roots: []config.Mount{{Daemon: "/x", Local: filepath.Join(dir, "missing")}}, DaemonConfig: config.Mount{Local: dir}, Upstream: "http://h"}); err == nil {
		t.Fatal("missing root")
	}
	if _, err := New(Options{Roots: []config.Mount{{Daemon: "/x", Local: file}}, DaemonConfig: config.Mount{Local: dir}, Upstream: "http://h"}); err == nil {
		t.Fatal("root is a file")
	}
	if _, err := New(Options{Roots: []config.Mount{{Daemon: "/x", Local: dir}}, DaemonConfig: config.Mount{Local: dir}, Upstream: "::"}); err == nil {
		t.Fatal("bad upstream")
	}
}

func TestRPCErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Header.Get("X-Test") {
		default:
			w.WriteHeader(http.StatusBadGateway)
		}
	}))
	defer srv.Close()
	c, err := newRPCClient(srv.URL, "u", "p")
	must(t, err)
	if _, err := c.session(context.Background()); err == nil || !strings.Contains(err.Error(), "502") {
		t.Fatalf("non-200: %v", err)
	}
	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1}`)
	}))
	defer empty.Close()
	c, _ = newRPCClient(empty.URL, "u", "p")
	if _, err := c.torrents(context.Background()); err == nil {
		t.Fatal("empty result")
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `not json`)
	}))
	defer bad.Close()
	c, _ = newRPCClient(bad.URL, "u", "p")
	if _, err := c.torrents(context.Background()); err == nil {
		t.Fatal("bad json")
	}
	c, _ = newRPCClient("http://127.0.0.1:1", "u", "p")
	if _, err := c.torrents(context.Background()); err == nil || !strings.Contains(err.Error(), "unreachable") {
		t.Fatalf("unreachable: %v", err)
	}
}

func TestBdecode(t *testing.T) {
	v, _, err := bdecode([]byte("d1:ai-3e1:bl1:xee"), 0, 0)
	must(t, err)
	d := v.(map[string]any)
	if d["a"] != int64(-3) || d["b"].([]any)[0] != "x" {
		t.Fatalf("decoded %v", d)
	}
	for _, bad := range []string{"", "i3", "l1:a", "d1:a", "di1e1:ae", "5:ab", "x", "-1:a", "d1:a" + "x"} {
		if _, _, err := bdecode([]byte(bad), 0, 0); err == nil {
			t.Errorf("%q should fail", bad)
		}
	}
	if _, _, err := bdecode([]byte(strings.Repeat("l", 100)+strings.Repeat("e", 100)), 0, 0); err == nil {
		t.Error("nesting past maxDepth should fail")
	}
}

func TestCategory(t *testing.T) {
	for name, want := range map[string]string{"a.MKV": "video", "a.flac": "audio", "a.srt": "subtitle", "a.png": "image",
		"a.nfo": "document", "a.rar": "archive", "a.iso": "disk image", "a.part": "partial", "a.torrent": "torrent", "a": "other"} {
		if got := category(name); got != want {
			t.Errorf("%s: %s, want %s", name, got, want)
		}
	}
}

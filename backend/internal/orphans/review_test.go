package orphans

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/trick77/transmission-ui/backend/internal/config"
)

// Turning the incomplete folder off leaves the torrents that started there
// where they are: their .part files are still owned.
func TestIncompleteFolderOwnedWhenDisabled(t *testing.T) {
	f := newFixture(t)
	f.file(f.inc, "Half/b.mkv.part", 4)
	f.daemon.set(tor("Half", f.data, "Half/b.mkv"))
	// The setting off is what the daemon reports; incomplete_dir stays filled in.
	if r := f.scan(); len(r.Entries) != 0 {
		t.Fatalf("live partial data offered: %v", paths(r))
	}
}

func TestBdecodeHugeLength(t *testing.T) {
	if _, _, err := bdecode([]byte("d4:infod4:name9223372036854775807:xee"), 0, 0); err == nil {
		t.Fatal("a length near MaxInt must fail, not panic")
	}
}

func TestScanSkipsWhatItCannotRead(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads everything")
	}
	f := newFixture(t)
	f.file(f.data, "fine/1.bin", 1)
	locked := filepath.Join(f.data, "locked")
	f.file(f.data, "locked/inner/x", 1)
	must(t, os.Chmod(filepath.Join(locked, "inner"), 0))
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(locked, "inner"), 0o755) })
	r := f.scan()
	if find(r, filepath.Join(f.data, "fine")) == nil || find(r, locked) != nil {
		t.Fatalf("entries: %v", paths(r))
	}
	if len(r.Warnings) != 1 || !strings.Contains(r.Warnings[0], "could not read "+locked) {
		t.Fatalf("warnings: %v", r.Warnings)
	}

	// Inside an owned folder the walk descends; an unreadable subfolder there is skipped too.
	must(t, os.Chmod(filepath.Join(locked, "inner"), 0o755))
	f.file(f.data, "Live/a.mkv", 1)
	f.file(f.data, "Live/sub/x", 1)
	must(t, os.Chmod(filepath.Join(f.data, "Live/sub"), 0))
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(f.data, "Live/sub"), 0o755) })
	f.daemon.set(tor("Live", f.data, "Live/a.mkv", "Live/sub/y"))
	r = f.scan()
	if !slices.ContainsFunc(r.Warnings, func(w string) bool { return strings.Contains(w, "Live/sub") }) {
		t.Fatalf("descend warning: %v", r.Warnings)
	}
}

func TestVanishedPathIsNoWarning(t *testing.T) {
	f := newFixture(t)
	w := &walker{ctx: context.Background(), mount: f.data, warn: func(m string) { t.Fatalf("warned: %s", m) }}
	w.skip("gone", os.ErrNotExist)
}

func TestUnparseableKeepListDoesNotLockTheFeature(t *testing.T) {
	f := newFixture(t)
	f.file(f.data, "a/1.bin", 1)
	must(t, os.WriteFile(filepath.Join(f.cfg, keepFile), []byte("{"), 0o644))
	st, err := f.svc.Status()
	if err != nil || st.KeptError == "" {
		t.Fatalf("status: %+v %v", st, err)
	}
	r := f.scan()
	if len(r.Entries) != 1 || !strings.Contains(strings.Join(r.Warnings, " "), "Forget all") {
		t.Fatalf("scan: %v %v", paths(r), r.Warnings)
	}
	// One Keep must not replace a list it cannot read: refused, file untouched.
	if err := f.svc.Keep(r.ID, r.Entries[0].ID); !errors.Is(err, errKeptLocked) {
		t.Fatalf("keep on an unreadable list: %v", err)
	}
	if err := f.svc.Unkeep(r.ID, r.Entries[0].ID); !errors.Is(err, errKeptLocked) {
		t.Fatalf("unkeep on an unreadable list: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(f.cfg, keepFile)); string(b) != "{" {
		t.Fatalf("the unreadable list was rewritten: %q", b)
	}
	// Forget all is the way out.
	must(t, f.svc.ForgetKept())
	must(t, f.svc.Keep(r.ID, r.Entries[0].ID))
	if st, _ := f.svc.Status(); st.KeptError != "" || len(st.Kept) != 1 {
		t.Fatalf("after forget and keep: %+v", st)
	}
}

// Quick K presses arrive at once: none of them may be lost.
func TestConcurrentKeepsAllStick(t *testing.T) {
	f := newFixture(t)
	for _, d := range []string{"a", "b", "c", "d", "e", "f"} {
		f.file(f.data, d+"/1.bin", 1)
	}
	r := f.scan()
	var wg sync.WaitGroup
	for _, e := range r.Entries {
		wg.Go(func() { must(t, f.svc.Keep(r.ID, e.ID)) })
	}
	wg.Wait()
	if st, _ := f.svc.Status(); len(st.Kept) != len(r.Entries) {
		t.Fatalf("kept %d of %d", len(st.Kept), len(r.Entries))
	}
}

// Every delete asks the daemon: a torrent added a moment after the previous
// delete still wins.
func TestEveryDeleteAsksTheDaemon(t *testing.T) {
	f := newFixture(t)
	f.file(f.data, "a/1.bin", 1)
	f.file(f.data, "b/1.bin", 1)
	r := f.scan()
	ctx := context.Background()
	must(t, f.svc.Delete(ctx, r.ID, find(r, filepath.Join(f.data, "a")).ID, "me"))
	f.daemon.set(tor("b", f.data, "b/1.bin"))
	var kept *KeptError
	if err := f.svc.Delete(ctx, r.ID, find(r, filepath.Join(f.data, "b")).ID, "me"); !errors.As(err, &kept) {
		t.Fatalf("re-added right after a delete: %v", err)
	}
	f.daemon.fail = "boom"
	if err := f.svc.Delete(ctx, r.ID, find(r, filepath.Join(f.data, "b")).ID, "me"); err == nil {
		t.Fatal("a delete without the daemon's answer must not happen")
	}
}

// A daemon path that lands inside a remapped root's local folder is some
// other folder here: no refusal on it. Anywhere else the refusal stands, even
// with a remapped root beside it.
func TestVisibilityCheckPerPath(t *testing.T) {
	f := newFixture(t)
	f.file(f.data, "other/1.bin", 1)
	f.daemon.session.DownloadDir = "/downloads"
	svc, err := New(Options{
		Roots:        []config.Mount{{Daemon: "/downloads", Local: f.data}, {Daemon: f.inc, Local: f.inc}},
		DaemonConfig: config.Mount{Daemon: f.cfg, Local: f.cfg},
		Upstream:     f.svc.rpc.endpoint, User: "u", Pass: "p",
	})
	must(t, err)
	f.daemon.set(tor("x", filepath.Join(f.data, "other"), "x/1"))
	r, err := svc.Scan(context.Background(), nil)
	if err != nil || len(r.Warnings) != 1 {
		t.Fatalf("under a remapped local: %v %v", err, r)
	}
	f.daemon.set(tor("x", t.TempDir(), "x/1"))
	if _, err := svc.Scan(context.Background(), nil); err == nil || !strings.Contains(err.Error(), "BACKEND_DATA_ROOTS") {
		t.Fatalf("visible elsewhere must still refuse: %v", err)
	}
}

// Every delete asks the cheap question; file lists only when it changed.
func TestDeletesFetchFileListsOnlyOnChange(t *testing.T) {
	f := newFixture(t)
	for _, d := range []string{"a", "b", "c", "d"} {
		f.file(f.data, d+"/1.bin", 1)
	}
	r := f.scan()
	ctx := context.Background()
	f.daemon.full = 0
	must(t, f.svc.Delete(ctx, r.ID, find(r, filepath.Join(f.data, "a")).ID, "me"))
	must(t, f.svc.Delete(ctx, r.ID, find(r, filepath.Join(f.data, "b")).ID, "me"))
	if f.daemon.full != 1 {
		t.Fatalf("full torrent_get calls for two deletes: %d", f.daemon.full)
	}
	f.daemon.set(tor("c", f.data, "c/1.bin"))
	var kept *KeptError
	if err := f.svc.Delete(ctx, r.ID, find(r, filepath.Join(f.data, "c")).ID, "me"); !errors.As(err, &kept) {
		t.Fatalf("a torrent added between deletes: %v", err)
	}
	if f.daemon.full != 2 {
		t.Fatalf("the change should refetch: %d", f.daemon.full)
	}
}

// A child vanishing mid-measure leaves the folder in the result.
func TestSummarizeSkipsVanishedChild(t *testing.T) {
	f := newFixture(t)
	f.file(f.data, "big/keep.bin", 5)
	f.file(f.data, "big/sub/tmp", 1)
	root, err := os.OpenRoot(f.data)
	must(t, err)
	defer func() { _ = root.Close() }()
	once := false
	e, err := summarize(root, "big", func(p string) {
		if p == "big/sub" && !once {
			once = true
			must(t, os.RemoveAll(filepath.Join(f.data, "big/sub")))
		}
	})
	if err != nil || e.Files != 1 || e.Size != 5 {
		t.Fatalf("summarize: %+v %v", e, err)
	}
}

func TestBusyIsNotAConflict(t *testing.T) {
	f := newFixture(t)
	f.svc.opMu.Lock()
	defer f.svc.opMu.Unlock()
	w := do(t, f.svc.Handler(), http.MethodPost, "/api/orphans/delete", `{"scan_id":"x","id":"y"}`)
	if w.Code != http.StatusLocked {
		t.Fatalf("busy: %d", w.Code)
	}
}

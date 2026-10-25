// Package orphans finds files under the download folders that no torrent in
// the daemon owns, plus the daemon's own leftover .torrent/.resume files, and
// deletes the ones a user decided on, one at a time.
//
// The browser never names a path. A scan keeps its result in memory, and a
// delete names an entry of that result by id; right before unlinking, the
// entry is checked again against what the daemon owns now and against what
// is on disk now.
package orphans

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/trick77/transmission-ui/backend/internal/config"
)

// resultTTL is how long a scan can be acted on. Long enough to review a big
// list, short enough that nobody deletes from a picture of last week's disk.
const resultTTL = 30 * time.Minute

// ErrBusy is a scan or delete while another one runs. Nothing was checked; the
// same request can simply be tried again.
var ErrBusy = errors.New("a scan or delete is already running")

// ErrExpired is a scan id that is gone: expired, replaced, or from before a restart.
var ErrExpired = errors.New("this scan has expired, scan again")

// KeptError is a delete the recheck refused: the entry is no longer an orphan,
// or no longer what the user looked at. Nothing was removed.
type KeptError struct{ Reason string }

func (e *KeptError) Error() string { return e.Reason }

// Options configures a Service.
type Options struct {
	Roots        []config.Mount
	DaemonConfig config.Mount
	Upstream     string
	User, Pass   string
	Log          *slog.Logger
}

// Service runs scans and deletes. One operation at a time.
type Service struct {
	roots  []config.Mount
	state  config.Mount
	rpc    *rpcClient
	log    *slog.Logger
	now    func() time.Time
	opMu   sync.Mutex // held for a whole scan or delete
	keepMu sync.Mutex // held for a read-modify-write of the Keep list
	mu     sync.Mutex // guards the fields below
	result *Result
	lastAt time.Time
	// The claims the last delete built, and the cheap fingerprint of the
	// daemon's answer they came from; see freshClaims.
	claims   *claims
	claimsFP string
}

// New checks that every folder is there and is a folder: a typo in a mount
// would otherwise only show as an empty scan.
func New(o Options) (*Service, error) {
	for _, m := range append(slices.Clone(o.Roots), o.DaemonConfig) {
		fi, err := os.Stat(m.Local)
		if err != nil {
			return nil, fmt.Errorf("orphan finder: %w", err)
		}
		if !fi.IsDir() {
			return nil, fmt.Errorf("orphan finder: %s is not a folder", m.Local)
		}
	}
	rpc, err := newRPCClient(o.Upstream, o.User, o.Pass)
	if err != nil {
		return nil, err
	}
	log := o.Log
	if log == nil {
		log = slog.Default()
	}
	return &Service{roots: o.Roots, state: o.DaemonConfig, rpc: rpc, log: log, now: time.Now}, nil
}

// Result is one scan.
type Result struct {
	ID         string   `json:"scan_id"`
	At         int64    `json:"at"`
	TookMS     int64    `json:"took_ms"`
	Looked     int      `json:"looked"` // paths looked at
	HiddenKept int      `json:"hidden_kept"`
	Warnings   []string `json:"warnings,omitempty"`
	Entries    []*Entry `json:"entries"`

	byID map[string]*Entry
	at   time.Time
}

// Status is what the Settings entry shows before any scan.
type Status struct {
	Roots     []RootStatus `json:"roots"`
	Config    string       `json:"config"`
	Kept      []Kept       `json:"kept"`
	KeptError string       `json:"kept_error,omitempty"`
	LastScan  int64        `json:"last_scan,omitempty"`
}

// RootStatus is one scanned folder.
type RootStatus struct {
	Path string `json:"path"`
	Free int64  `json:"free"`
}

// Status lists the folders, their free space and the remembered Keeps.
func (s *Service) Status() (Status, error) {
	st := Status{Config: s.state.Daemon, Kept: []Kept{}}
	for _, m := range s.roots {
		st.Roots = append(st.Roots, RootStatus{Path: m.Daemon, Free: free(m.Local)})
	}
	kept, err := s.withState(loadKept)
	switch {
	case errors.Is(err, errKeptUnreadable):
		st.KeptError = err.Error()
	case err != nil:
		return st, err
	case kept != nil:
		st.Kept = kept
	}
	s.mu.Lock()
	if !s.lastAt.IsZero() {
		st.LastScan = s.lastAt.Unix()
	}
	s.mu.Unlock()
	return st, nil
}

// withState runs f on the daemon's config folder, one at a time: Keeps come in
// quick runs of K presses, and two read-modify-writes of the list at once would
// each drop the other's entry.
func (s *Service) withState(f func(*os.Root) ([]Kept, error)) ([]Kept, error) {
	s.keepMu.Lock()
	defer s.keepMu.Unlock()
	root, err := os.OpenRoot(s.state.Local)
	if err != nil {
		return nil, err
	}
	defer func() { _ = root.Close() }()
	return f(root)
}

// Scan walks every root and the daemon's state folder. progress is called
// with the number of paths looked at and the current one, as often as it
// likes; ctx ends the scan (the browser's Stop closes the request).
func (s *Service) Scan(ctx context.Context, progress func(looked int, current string)) (*Result, error) {
	if !s.opMu.TryLock() {
		return nil, ErrBusy
	}
	defer s.opMu.Unlock()
	start := s.now()
	sess, err := s.rpc.session(ctx)
	if err != nil {
		return nil, err
	}
	// The state files are only judged right when this is the daemon's folder.
	if path.Clean(sess.ConfigDir) != s.state.Daemon {
		return nil, fmt.Errorf("the daemon's config folder is %s, but BACKEND_DAEMON_CONFIG names %s", sess.ConfigDir, s.state.Daemon)
	}
	ts, err := s.rpc.torrents(ctx)
	if err != nil {
		return nil, err
	}
	c := newClaims(s.roots, sess, ts)
	res := &Result{byID: map[string]*Entry{}}
	for dir, n := range c.outside {
		// Mounted here but not scanned: the same storage under a second name
		// would make every file of those torrents look orphaned in the root
		// that is scanned. Refuse rather than guess.
		if _, err := os.Lstat(dir); err == nil && !s.underMappedLocal(dir) {
			return nil, fmt.Errorf("%d torrent(s) keep their data in %s, which this container can see but BACKEND_DATA_ROOTS does not list: add it, or the scan cannot tell what they own", n, dir)
		}
		res.Warnings = append(res.Warnings, fmt.Sprintf("%d torrent(s) keep their data in %s, which is not scanned", n, dir))
	}

	looked, last := 0, time.Time{}
	seen := func(rel string) {
		looked++
		if progress != nil && s.now().Sub(last) >= 250*time.Millisecond {
			last = s.now()
			progress(looked, rel)
		}
	}
	var found []*Entry
	for i, m := range s.roots {
		root, err := os.OpenRoot(m.Local)
		if err != nil {
			return nil, err
		}
		w := &walker{ctx: ctx, i: i, root: root, mount: m.Daemon, c: c, now: start,
			seen: func(rel string) { seen(path.Join(m.Daemon, rel)) },
			warn: func(msg string) { res.Warnings = append(res.Warnings, msg) }}
		err = w.visit(".")
		_ = root.Close()
		if err != nil {
			return nil, err
		}
		found = append(found, w.out...)
	}
	stateRoot, err := os.OpenRoot(s.state.Local)
	if err != nil {
		return nil, err
	}
	stateEntries, err := scanState(stateRoot, s.state.Daemon, c)
	if err != nil {
		_ = stateRoot.Close()
		return nil, err
	}
	s.keepMu.Lock()
	kept, err := loadKept(stateRoot)
	s.keepMu.Unlock()
	_ = stateRoot.Close()
	if errors.Is(err, errKeptUnreadable) {
		res.Warnings = append(res.Warnings, err.Error()+": everything is shown; Forget all in Settings resets the list")
	} else if err != nil {
		return nil, err
	}
	found = append(found, stateEntries...)

	// Ask again at the end: a torrent added or moved while the disk was being
	// walked owns its files now, so they are not offered.
	ts2, err := s.rpc.torrents(ctx)
	if err != nil {
		return nil, err
	}
	c2 := newClaims(s.roots, sess, ts2)
	for _, e := range found {
		if e.root >= 0 {
			if _, owned := c2.owner(e.root, nfc(e.rel)); owned {
				continue
			}
		} else if c2.loaded(e.Hash) {
			continue
		}
		if slices.ContainsFunc(kept, func(k Kept) bool { return k.matches(e) }) {
			res.HiddenKept++
			continue
		}
		res.Entries = append(res.Entries, e)
	}
	order := func(e *Entry) int {
		if e.root < 0 {
			return len(s.roots)
		}
		return e.root
	}
	slices.SortStableFunc(res.Entries, func(a, b *Entry) int {
		if d := order(a) - order(b); d != 0 {
			return d
		}
		return cmpDesc(a.Size, b.Size)
	})
	for n, e := range res.Entries {
		e.ID = "e" + strconv.Itoa(n+1)
		res.byID[e.ID] = e
	}
	slices.Sort(res.Warnings)
	res.ID = newID()
	res.at = s.now()
	res.At = res.at.Unix()
	res.TookMS = res.at.Sub(start).Milliseconds()
	res.Looked = looked
	s.mu.Lock()
	s.result, s.lastAt = res, res.at
	s.mu.Unlock()
	return res, nil
}

// underMappedLocal reports whether a daemon path, read as a path here, lands
// inside a root that this container mounts under another name. There it is
// some other folder, so seeing it proves nothing; everywhere else the paths are
// the daemon's, and a visible unlisted folder must stop the scan.
func (s *Service) underMappedLocal(p string) bool {
	for _, m := range s.roots {
		if m.Daemon != m.Local && within(p, m.Local) {
			return true
		}
	}
	return false
}

func (s *Service) entry(scanID, id string) (*Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.result
	if r == nil || r.ID != scanID || s.now().Sub(r.at) > resultTTL {
		return nil, ErrExpired
	}
	e := r.byID[id]
	if e == nil {
		return nil, fmt.Errorf("no entry %q in this scan", id)
	}
	return e, nil
}

// errKeptLocked refuses a Keep or Unkeep while the list does not parse:
// writing it would replace every earlier Keep without a word.
var errKeptLocked = errors.New("the remembered Keeps cannot be read, so this decision cannot be saved: Forget all in Settings resets the list")

// Keep remembers an entry as decided-on, so later scans hide it while it is
// unchanged. Keeping twice is fine.
func (s *Service) Keep(scanID, id string) error {
	e, err := s.entry(scanID, id)
	if err != nil {
		return err
	}
	_, err = s.withState(func(root *os.Root) ([]Kept, error) {
		k, err := loadKept(root)
		if errors.Is(err, errKeptUnreadable) {
			return nil, errKeptLocked
		}
		if err != nil {
			return nil, err
		}
		k = slices.DeleteFunc(k, func(x Kept) bool { return x.Path == e.Path })
		k = append(k, Kept{Path: e.Path, Size: e.Size, Files: e.Files, MTime: e.MTime})
		return nil, saveKept(root, k)
	})
	return err
}

// Unkeep forgets one entry's Keep: a decision taken back in the review.
func (s *Service) Unkeep(scanID, id string) error {
	e, err := s.entry(scanID, id)
	if err != nil {
		return err
	}
	_, err = s.withState(func(root *os.Root) ([]Kept, error) {
		k, err := loadKept(root)
		if errors.Is(err, errKeptUnreadable) {
			return nil, errKeptLocked
		}
		if err != nil {
			return nil, err
		}
		return nil, saveKept(root, slices.DeleteFunc(k, func(x Kept) bool { return x.Path == e.Path }))
	})
	return err
}

// ForgetKept drops every remembered Keep.
func (s *Service) ForgetKept() error {
	_, err := s.withState(func(root *os.Root) ([]Kept, error) { return nil, saveKept(root, nil) })
	return err
}

// Delete removes one entry of the current scan after checking it again: the
// daemon must still not own it, and it must be what the scan saw. who is the
// signed-in user, for the log line that is the audit trail.
func (s *Service) Delete(ctx context.Context, scanID, id, who string) error {
	if !s.opMu.TryLock() {
		return ErrBusy
	}
	defer s.opMu.Unlock()
	e, err := s.entry(scanID, id)
	if err != nil {
		return err
	}
	c, err := s.freshClaims(ctx)
	if err != nil {
		return err
	}
	if e.root < 0 {
		err = s.deleteState(e, c)
	} else {
		err = s.deleteData(e, c)
	}
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.result != nil {
		delete(s.result.byID, e.ID)
	}
	s.mu.Unlock()
	s.log.InfoContext(ctx, "orphan deleted", "path", e.Path, "kind", e.Kind, "bytes", e.Size, "files", e.Files, "user", who)
	return nil
}

// freshClaims asks the daemon what it owns right now, for every single delete:
// a torrent re-added a moment ago must win over the scan. Each delete asks the
// cheap question (which torrents, named what, where, and the session's
// folders); the file lists, which can run to megabytes, are fetched again only
// when that answer differs from the one the cached claims were built from.
func (s *Service) freshClaims(ctx context.Context) (*claims, error) {
	sess, err := s.rpc.session(ctx)
	if err != nil {
		return nil, err
	}
	ids, err := s.rpc.identities(ctx)
	if err != nil {
		return nil, err
	}
	fp := fingerprint(sess, ids)
	s.mu.Lock()
	c, cfp := s.claims, s.claimsFP
	s.mu.Unlock()
	if c != nil && cfp == fp {
		return c, nil
	}
	ts, err := s.rpc.torrents(ctx)
	if err != nil {
		return nil, err
	}
	c = newClaims(s.roots, sess, ts)
	// Keyed by what the full answer says, so a change between the two calls
	// cannot pair new claims with the old fingerprint.
	s.mu.Lock()
	s.claims, s.claimsFP = c, fingerprint(sess, ts)
	s.mu.Unlock()
	return c, nil
}

func fingerprint(sess session, ts []torrent) string {
	parts := make([]string, 0, len(ts)+1)
	parts = append(parts, sess.DownloadDir+"\x00"+sess.IncompleteDir)
	for _, t := range ts {
		parts = append(parts, fmt.Sprint(t.ID)+"\x00"+t.HashString+"\x00"+t.Name+"\x00"+t.DownloadDir)
	}
	slices.Sort(parts[1:])
	return strings.Join(parts, "\x01")
}

func (s *Service) deleteData(e *Entry, c *claims) error {
	if o, owned := c.owner(e.root, nfc(e.rel)); owned {
		return &KeptError{Reason: "now belongs to " + o}
	}
	root, err := os.OpenRoot(s.roots[e.root].Local)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	now, err := summarize(root, e.rel, nil)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &KeptError{Reason: "already gone"}
		}
		return err
	}
	if now.Size != e.Size || now.Files != e.Files || now.MTime != e.MTime || now.Kind != e.Kind {
		return &KeptError{Reason: "changed since the scan"}
	}
	// Inside the root by construction: os.Root refuses any path, symlink
	// included, that would leave it.
	return root.RemoveAll(e.rel)
}

func (s *Service) deleteState(e *Entry, c *claims) error {
	if c.loaded(e.Hash) {
		return &KeptError{Reason: "loaded in Transmission again"}
	}
	root, err := os.OpenRoot(s.state.Local)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	for _, rel := range e.state {
		if err := root.Remove(rel); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func newID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

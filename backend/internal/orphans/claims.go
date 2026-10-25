package orphans

import (
	"path"
	"strings"

	"golang.org/x/text/unicode/norm"

	"github.com/trick77/transmission-ui/backend/internal/config"
)

// claims is everything the daemon owns, located in the scanned roots. Paths are
// root-relative, slash-separated and NFC: a name the daemon spells in NFC and
// the disk in NFD (written by a Mac client) is the same file, and treating them
// as different would offer a live torrent's data for deletion.
type claims struct {
	roots []config.Mount
	// files: a claimed file, and the torrent owning it.
	files []map[string]string
	// descend: folders on the way to something claimed, root to leaf. Their
	// contents are inspected one by one; the folder itself is never an orphan.
	descend []map[string]bool
	// owned: folders inside a torrent (below its download_dir), and the owner.
	// An unclaimed path in one is a stray inside that torrent's folder.
	owned []map[string]string
	// whole: a torrent's folder that is claimed with everything in it, for a
	// torrent whose file list is not known yet (a magnet without metadata).
	whole []map[string]string

	hashes   map[string]bool // loaded info hashes, lower-case hex
	prefixes map[string]bool // their first 16 hex digits, for the pre-4.0 file names
	names    map[string]string
	// outside: download folders that are in no root, and how many torrents use each.
	outside map[string]int
}

func nfc(s string) string { return norm.NFC.String(s) }

func newClaims(roots []config.Mount, s session, ts []torrent) *claims {
	c := &claims{
		roots:    roots,
		files:    make([]map[string]string, len(roots)),
		descend:  make([]map[string]bool, len(roots)),
		owned:    make([]map[string]string, len(roots)),
		whole:    make([]map[string]string, len(roots)),
		hashes:   map[string]bool{},
		prefixes: map[string]bool{},
		names:    map[string]string{},
		outside:  map[string]int{},
	}
	for i := range roots {
		c.files[i], c.descend[i], c.owned[i], c.whole[i] =
			map[string]string{}, map[string]bool{}, map[string]string{}, map[string]string{}
	}
	// The daemon's own folders are structure, never an orphan, even with no
	// torrent in them right now.
	c.structural(s.DownloadDir)
	if s.IncompleteDirEnabled {
		c.structural(s.IncompleteDir)
	}
	for _, t := range ts {
		h := strings.ToLower(t.HashString)
		c.hashes[h] = true
		if len(h) >= 16 {
			c.prefixes[h[:16]] = true
		}
		c.names[nfc(t.Name)] = t.DownloadDir
		bases := []string{t.DownloadDir}
		if s.IncompleteDirEnabled && s.IncompleteDir != "" {
			bases = append(bases, s.IncompleteDir)
		}
		if _, _, ok := c.locate(t.DownloadDir); !ok {
			c.outside[path.Clean(t.DownloadDir)]++
		}
		for _, base := range bases {
			c.structural(base)
			if len(t.Files) == 0 {
				if i, rel, ok := c.locate(path.Join(base, t.Name)); ok && rel != "." {
					c.whole[i][rel] = t.Name
					c.ancestors(i, rel, base, t.Name)
				}
				continue
			}
			for _, f := range t.Files {
				full := path.Join(base, f.Name)
				// A torrent being downloaded, or one stopped half-way, has its files
				// under the .part name; claiming both costs nothing.
				for _, p := range []string{full, full + ".part"} {
					i, rel, ok := c.locate(p)
					if !ok || rel == "." {
						continue
					}
					c.files[i][rel] = t.Name
					c.ancestors(i, rel, base, t.Name)
				}
			}
		}
	}
	return c
}

// structural marks a daemon folder and its ancestors as places to look into.
func (c *claims) structural(daemonPath string) {
	if daemonPath == "" {
		return
	}
	if i, rel, ok := c.locate(daemonPath); ok {
		for d := rel; d != "." && d != "/"; d = path.Dir(d) {
			c.descend[i][d] = true
		}
	}
}

// ancestors records the folders above rel: all of them as descend, and those
// below the torrent's base folder as owned by it.
func (c *claims) ancestors(i int, rel, base, owner string) {
	_, baseRel, _ := c.locate(base)
	for d := path.Dir(rel); d != "."; d = path.Dir(d) {
		c.descend[i][d] = true
		if d != baseRel && within(d, baseRel) {
			if _, ok := c.owned[i][d]; !ok {
				c.owned[i][d] = owner
			}
		}
	}
}

// locate maps a path as the daemon names it onto a root: its index and the
// NFC root-relative path ("." for the root itself).
func (c *claims) locate(daemonPath string) (int, string, bool) {
	p := path.Clean(daemonPath)
	for i, m := range c.roots {
		if p == m.Daemon {
			return i, ".", true
		}
		if strings.HasPrefix(p, m.Daemon+"/") {
			return i, nfc(strings.TrimPrefix(p, m.Daemon+"/")), true
		}
	}
	return 0, "", false
}

// wholeOwner is the torrent claiming rel as part of a whole folder, if any.
func (c *claims) wholeOwner(i int, rel string) (string, bool) {
	for d := rel; d != "."; d = path.Dir(d) {
		if o, ok := c.whole[i][d]; ok {
			return o, true
		}
	}
	return "", false
}

// owner is the torrent that claims rel or anything below it. A delete asks this
// right before it unlinks, so a torrent added since the scan wins.
func (c *claims) owner(i int, rel string) (string, bool) {
	if o, ok := c.files[i][rel]; ok {
		return o, true
	}
	if o, ok := c.wholeOwner(i, rel); ok {
		return o, true
	}
	if c.descend[i][rel] {
		return c.firstBelow(i, rel), true
	}
	return "", false
}

// firstBelow names one torrent with a claimed file below rel, for the message.
func (c *claims) firstBelow(i int, rel string) string {
	for f, o := range c.files[i] {
		if within(f, rel) {
			return o
		}
	}
	for d, o := range c.whole[i] {
		if within(d, rel) {
			return o
		}
	}
	return "a torrent"
}

func (c *claims) loaded(hash string) bool {
	if len(hash) == 16 {
		return c.prefixes[hash]
	}
	return c.hashes[hash]
}

// within reports whether p is q or below it; "." contains everything.
func within(p, q string) bool {
	return q == "." || p == q || strings.HasPrefix(p, q+"/")
}

package orphans

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path"
	"slices"
	"strings"
	"time"
)

// Entry is one orphan: the top-most path nothing owns. A removed torrent's
// folder is one entry however many files it holds; a stray file inside a live
// torrent's folder is its own.
type Entry struct {
	ID    string `json:"id"`
	Group string `json:"group"` // the root as the daemon names it, or StateGroup
	Path  string `json:"path"`  // full path as the daemon names it
	Kind  string `json:"kind"`  // file, dir, empty, symlink, state
	Size  int64  `json:"size"`
	Files int    `json:"files"`
	MTime int64  `json:"mtime"` // newest change anywhere in it, unix seconds
	// Flags: hardlink, inside, partial, recent, torrent, match, state.
	Flags  []string `json:"flags,omitempty"`
	Inside string   `json:"inside,omitempty"` // the live torrent whose folder it sits in
	// Match is where a loaded torrent with this very name keeps its data: the
	// sign that one storage is mounted under two names.
	Match    string         `json:"match,omitempty"`
	Name     string         `json:"name,omitempty"` // torrent name read from a .torrent, .magnet or .resume
	Hash     string         `json:"hash,omitempty"`
	Types    map[string]int `json:"types,omitempty"`
	Children []Child        `json:"children,omitempty"`

	root  int      // index into the roots; -1 for daemon state
	rel   string   // root-relative, as on disk
	state []string // config-relative files of a state entry
}

// Child is one of the largest things directly inside a folder entry.
type Child struct {
	Name  string `json:"name"`
	Dir   bool   `json:"dir"`
	Size  int64  `json:"size"`
	Files int    `json:"files"`
}

// recentFor is how fresh a change has to be for the "may be in use" tag.
const recentFor = 15 * time.Minute

// maxChildren bounds the contents preview of a folder entry.
const maxChildren = 6

// skipNames are filesystem and NAS housekeeping, never anybody's download.
var skipNames = map[string]bool{
	"lost+found": true, ".zfs": true, ".snapshot": true, "@eaDir": true, "#recycle": true,
	".stfolder": true, ".DS_Store": true,
}

func skipped(name string) bool {
	return skipNames[name] || strings.HasPrefix(name, ".Trash-")
}

// walker scans one root against the claimed set.
type walker struct {
	ctx   context.Context
	i     int
	root  *os.Root
	mount string // the root as the daemon names it
	c     *claims
	now   time.Time
	seen  func(rel string) // progress, once per path looked at
	out   []*Entry
}

func (w *walker) visit(rel string) error {
	ents, err := readDir(w.root, rel)
	if err != nil {
		return err
	}
	for _, de := range ents {
		if err := w.ctx.Err(); err != nil {
			return err
		}
		if skipped(de.Name()) {
			continue
		}
		crel := join(rel, de.Name())
		key := nfc(crel)
		w.seen(crel)
		if _, ok := w.c.wholeOwner(w.i, key); ok {
			continue
		}
		if de.IsDir() {
			if w.c.descend[w.i][key] {
				if err := w.visit(crel); err != nil {
					return err
				}
				continue
			}
			e, err := summarize(w.root, crel, w.seen)
			if err != nil {
				return err
			}
			w.add(e, key)
			continue
		}
		if _, ok := w.c.files[w.i][key]; ok {
			continue
		}
		e, err := summarize(w.root, crel, w.seen)
		if err != nil {
			return err
		}
		w.add(e, key)
	}
	return nil
}

func (w *walker) add(e *Entry, key string) {
	e.root, e.Group, e.Path = w.i, w.mount, path.Join(w.mount, e.rel)
	if o, ok := w.c.owned[w.i][path.Dir(key)]; ok {
		e.Inside = o
		e.Flags = append(e.Flags, "inside")
	}
	base := strings.TrimSuffix(path.Base(key), ".part")
	if dir, ok := w.c.names[base]; ok && e.Inside == "" {
		e.Match = dir
		e.Flags = append(e.Flags, "match")
	}
	if e.Kind == "file" {
		switch {
		case strings.HasSuffix(e.rel, ".part"):
			e.Flags = append(e.Flags, "partial")
		case strings.HasSuffix(e.rel, ".torrent"):
			e.Flags = append(e.Flags, "torrent")
			e.Name = torrentName(w.root, e.rel)
		}
	}
	if w.now.Sub(time.Unix(e.MTime, 0)) < recentFor {
		e.Flags = append(e.Flags, "recent")
	}
	w.out = append(w.out, e)
}

// summarize measures one path without following symlinks: size, file count,
// newest change, contents mix and, for a folder, its largest children. It is
// also the fingerprint a delete compares against.
func summarize(root *os.Root, rel string, seen func(string)) (*Entry, error) {
	info, err := root.Lstat(rel)
	if err != nil {
		return nil, err
	}
	e := &Entry{rel: rel, MTime: info.ModTime().Unix()}
	switch {
	case info.Mode()&fs.ModeSymlink != 0:
		e.Kind, e.Size, e.Files = "symlink", info.Size(), 1
		return e, nil
	case !info.IsDir():
		e.Kind, e.Size, e.Files = "file", info.Size(), 1
		e.Types = map[string]int{category(rel): 1}
		if links(info) > 1 {
			e.Flags = append(e.Flags, "hardlink")
		}
		return e, nil
	}
	e.Kind, e.Types = "dir", map[string]int{}
	allLinked := true
	kids := map[string]*Child{}
	var walk func(dir, top string) error
	walk = func(dir, top string) error {
		ents, err := readDir(root, dir)
		if err != nil {
			return err
		}
		for _, de := range ents {
			p := join(dir, de.Name())
			if seen != nil {
				seen(p)
			}
			t := top
			if t == "" {
				t = de.Name()
				kids[t] = &Child{Name: t, Dir: de.IsDir()}
			}
			fi, err := de.Info()
			if err != nil {
				return err
			}
			if m := fi.ModTime().Unix(); m > e.MTime {
				e.MTime = m
			}
			if de.IsDir() {
				if err := walk(p, t); err != nil {
					return err
				}
				continue
			}
			e.Size += fi.Size()
			e.Files++
			kids[t].Size += fi.Size()
			kids[t].Files++
			e.Types[category(p)]++
			if fi.Mode().IsRegular() && links(fi) <= 1 {
				allLinked = false
			}
		}
		return nil
	}
	if err := walk(rel, ""); err != nil {
		return nil, err
	}
	if e.Files == 0 {
		e.Kind, e.Types = "empty", nil
	} else if allLinked {
		e.Flags = append(e.Flags, "hardlink")
	}
	for _, k := range kids {
		e.Children = append(e.Children, *k)
	}
	slices.SortFunc(e.Children, func(a, b Child) int {
		if a.Size != b.Size {
			return cmpDesc(a.Size, b.Size)
		}
		return strings.Compare(a.Name, b.Name)
	})
	if len(e.Children) > maxChildren {
		e.Children = e.Children[:maxChildren]
	}
	return e, nil
}

func readDir(root *os.Root, rel string) ([]fs.DirEntry, error) {
	f, err := root.Open(rel)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	ents, err := f.ReadDir(-1)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	return ents, nil
}

func join(dir, name string) string {
	if dir == "." {
		return name
	}
	return dir + "/" + name
}

func cmpDesc(a, b int64) int {
	switch {
	case a > b:
		return -1
	case a < b:
		return 1
	}
	return 0
}

// category is the contents summary's word for a file, by extension.
func category(name string) string {
	ext := strings.ToLower(path.Ext(name))
	switch ext {
	case ".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm", ".ts", ".wmv", ".mpg", ".mpeg":
		return "video"
	case ".mp3", ".flac", ".m4a", ".m4b", ".ogg", ".opus", ".wav", ".aac":
		return "audio"
	case ".srt", ".ass", ".ssa", ".sub", ".idx", ".vtt":
		return "subtitle"
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff":
		return "image"
	case ".txt", ".nfo", ".md", ".pdf", ".epub", ".sfv", ".md5", ".sha256", ".json", ".xml", ".csv":
		return "document"
	case ".zip", ".rar", ".7z", ".tar", ".gz", ".xz", ".bz2", ".zst":
		return "archive"
	case ".iso", ".img", ".dmg", ".qcow2", ".vmdk":
		return "disk image"
	case ".part":
		return "partial"
	case ".torrent":
		return "torrent"
	}
	return "other"
}

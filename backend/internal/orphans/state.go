package orphans

import (
	"errors"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// StateGroup groups the daemon's own leftover files in a scan result.
const StateGroup = "Transmission state"

// The daemon keeps one file set per torrent under its config folder, named by
// info hash (libtransmission/torrent-metainfo.h, 4.1.3): torrents/<hash>.torrent,
// or .magnet while the metadata is missing, and resume/<hash>.resume. Before
// 4.0 the name was <name>.<first 16 hex>.<suffix>; the daemon migrates those on
// load, so one still lying around belongs to nothing.
var (
	hashFile   = regexp.MustCompile(`^([0-9a-f]{40})\.(torrent|magnet|resume)$`)
	legacyFile = regexp.MustCompile(`^.+\.([0-9a-f]{16})\.(torrent|magnet|resume)$`)
)

var stateDirs = []string{"torrents", "resume"}

// scanState lists the file sets in the daemon's config folder whose hash is not
// loaded. Nothing else in that folder is ever looked at.
func scanState(root *os.Root, mount string, c *claims) ([]*Entry, error) {
	byHash := map[string]*Entry{}
	for _, dir := range stateDirs {
		ents, err := readDir(root, dir)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, de := range ents {
			if !de.Type().IsRegular() {
				continue
			}
			hash := stateHash(de.Name())
			if hash == "" || c.loaded(hash) {
				continue
			}
			fi, err := de.Info()
			if err != nil {
				return nil, err
			}
			e := byHash[hash]
			if e == nil {
				e = &Entry{Group: StateGroup, Kind: "state", Hash: hash, root: -1, Flags: []string{"state"}}
				byHash[hash] = e
			}
			rel := dir + "/" + de.Name()
			e.state = append(e.state, rel)
			e.Size += fi.Size()
			e.Files++
			if m := fi.ModTime().Unix(); m > e.MTime {
				e.MTime = m
			}
		}
	}
	out := make([]*Entry, 0, len(byHash))
	for _, e := range byHash {
		slices.Sort(e.state)
		e.rel = e.state[0]
		e.Path = path.Join(mount, e.state[0])
		for _, rel := range e.state {
			if n := stateName(root, rel); n != "" {
				e.Name = n
				break
			}
		}
		out = append(out, e)
	}
	return out, nil
}

// stateHash is the hash a state file is named after, "" when it is not one.
func stateHash(name string) string {
	if m := hashFile.FindStringSubmatch(name); m != nil {
		return m[1]
	}
	if m := legacyFile.FindStringSubmatch(name); m != nil {
		return m[1]
	}
	return ""
}

// stateName reads the torrent's name out of a state file, "" when it has none.
func stateName(root *os.Root, rel string) string {
	switch path.Ext(rel) {
	case ".torrent":
		return torrentName(root, rel)
	case ".resume":
		d, ok := decodeFile(root, rel).(map[string]any)
		if !ok {
			return ""
		}
		s, _ := d["name"].(string)
		return s
	case ".magnet":
		b, err := readSmall(root, rel)
		if err != nil {
			return ""
		}
		u, err := url.Parse(strings.TrimSpace(string(b)))
		if err != nil {
			return ""
		}
		return u.Query().Get("dn")
	}
	return ""
}

// torrentName is info.name of a .torrent file, "" when unreadable.
func torrentName(root *os.Root, rel string) string {
	d, ok := decodeFile(root, rel).(map[string]any)
	if !ok {
		return ""
	}
	info, ok := d["info"].(map[string]any)
	if !ok {
		return ""
	}
	s, _ := info["name"].(string)
	return s
}

// maxStateFile bounds what is read for a name: a .torrent of a huge torrent
// carries megabytes of piece hashes, a stray file under a data root may be
// anything.
const maxStateFile = 16 << 20

func readSmall(root *os.Root, rel string) ([]byte, error) {
	f, err := root.Open(rel)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, maxStateFile))
}

func decodeFile(root *os.Root, rel string) any {
	b, err := readSmall(root, rel)
	if err != nil {
		return nil
	}
	v, _, err := bdecode(b, 0, 0)
	if err != nil {
		return nil
	}
	return v
}

var errBencode = errors.New("malformed bencode")

// maxDepth bounds nesting: real files go four levels deep, a crafted one could
// otherwise recurse until the stack gives out.
const maxDepth = 32

// bdecode reads one bencoded value at b[i:]: integers, strings, lists and
// dictionaries, enough to read a name. Byte strings come back as Go strings.
func bdecode(b []byte, i, depth int) (any, int, error) {
	if i >= len(b) || depth > maxDepth {
		return nil, i, errBencode
	}
	switch c := b[i]; {
	case c == 'i':
		end := indexFrom(b, 'e', i+1)
		if end < 0 {
			return nil, i, errBencode
		}
		n, err := strconv.ParseInt(string(b[i+1:end]), 10, 64)
		return n, end + 1, err
	case c == 'l':
		var l []any
		for i++; i < len(b) && b[i] != 'e'; {
			v, next, err := bdecode(b, i, depth+1)
			if err != nil {
				return nil, i, err
			}
			l, i = append(l, v), next
		}
		if i >= len(b) {
			return nil, i, errBencode
		}
		return l, i + 1, nil
	case c == 'd':
		d := map[string]any{}
		for i++; i < len(b) && b[i] != 'e'; {
			k, next, err := bdecode(b, i, depth+1)
			if err != nil {
				return nil, i, err
			}
			key, ok := k.(string)
			if !ok {
				return nil, i, errBencode
			}
			v, next2, err := bdecode(b, next, depth+1)
			if err != nil {
				return nil, i, err
			}
			d[key], i = v, next2
		}
		if i >= len(b) {
			return nil, i, errBencode
		}
		return d, i + 1, nil
	case c >= '0' && c <= '9':
		colon := indexFrom(b, ':', i)
		if colon < 0 {
			return nil, i, errBencode
		}
		n, err := strconv.Atoi(string(b[i:colon]))
		if err != nil || n < 0 || colon+1+n > len(b) {
			return nil, i, errBencode
		}
		return string(b[colon+1 : colon+1+n]), colon + 1 + n, nil
	}
	return nil, i, errBencode
}

func indexFrom(b []byte, c byte, from int) int {
	for j := from; j < len(b); j++ {
		if b[j] == c {
			return j
		}
	}
	return -1
}

package orphans

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
)

// errKeptUnreadable is a Keep list that does not parse (edited by hand,
// truncated). It must not lock the feature: status reports it, a scan warns
// and shows everything, and the next Keep or Forget all rewrites the file.
var errKeptUnreadable = errors.New("the remembered Keeps cannot be read")

// keepFile lives in the daemon's config folder, the one place both mounted and
// shared by every browser. The daemon ignores files it does not know.
const keepFile = "transmission-ui-kept.json"

// Kept is a path the user decided to keep. It stays hidden from scans while it
// is unchanged; a change in size, file count or newest mtime brings it back.
type Kept struct {
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	Files int    `json:"files"`
	MTime int64  `json:"mtime"`
}

func (k Kept) matches(e *Entry) bool {
	return k.Path == e.Path && k.Size == e.Size && k.Files == e.Files && k.MTime == e.MTime
}

func loadKept(root *os.Root) ([]Kept, error) {
	b, err := root.ReadFile(keepFile)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var k []Kept
	if err := json.Unmarshal(b, &k); err != nil {
		return nil, fmt.Errorf("%w: %w", errKeptUnreadable, err)
	}
	return k, nil
}

// saveKept writes the list whole and renames it into place, so a crash halfway
// leaves the old list rather than half a file.
func saveKept(root *os.Root, k []Kept) error {
	if len(k) == 0 {
		err := root.Remove(keepFile)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	b, err := json.MarshalIndent(k, "", "  ")
	if err != nil {
		return err
	}
	tmp := keepFile + ".tmp"
	if err := root.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return root.Rename(tmp, keepFile)
}

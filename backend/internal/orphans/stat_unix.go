//go:build unix

package orphans

import (
	"io/fs"
	"syscall"
)

// links is a file's hard-link count; 1 when the platform does not say. Nlink is
// uint16 on darwin and uint64 on linux.
func links(info fs.FileInfo) uint64 {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Nlink) //nolint:unconvert // uint16 on darwin
	}
	return 1
}

// free is the space left on the filesystem holding dir, 0 when unknown.
func free(dir string) int64 {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0
	}
	return int64(st.Bavail) * int64(st.Bsize) //nolint:gosec,unconvert // block counts fit; types differ per platform
}

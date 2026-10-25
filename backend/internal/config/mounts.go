package config

import (
	"path"
	"strings"

	"github.com/trick77/ship/kit/env"
)

// Mount is a folder the daemon writes to, as the daemon names it and as this
// container sees it. The two are the same path unless the operator mapped it
// (daemon=local), which is for setups where the daemon's paths cannot change.
type Mount struct {
	Daemon string
	Local  string
}

// loadMounts reads the orphan finder's folders. They come as a pair: the data
// roots to scan and the daemon's config folder, which holds its own leftover
// .torrent/.resume files and the remembered Keep decisions. Half a setup would
// either miss the daemon's state or have nowhere to keep a Keep, so it is a
// startup error rather than a quietly reduced feature.
func loadMounts(r *env.Reader, cfg *Config) {
	roots := r.List("BACKEND_DATA_ROOTS", nil)
	daemonCfg := r.String("BACKEND_DAEMON_CONFIG", "")
	if len(roots) == 0 && daemonCfg == "" {
		return
	}
	if len(roots) == 0 || daemonCfg == "" {
		r.Fail("BACKEND_DATA_ROOTS and BACKEND_DAEMON_CONFIG go together: set both to enable the orphan finder, or neither")
		return
	}
	for _, raw := range roots {
		m, ok := parseMount(raw)
		if !ok {
			r.Fail("BACKEND_DATA_ROOTS entry %q must be an absolute path, or daemon=local with two absolute paths", raw)
			continue
		}
		cfg.DataRoots = append(cfg.DataRoots, m)
	}
	m, ok := parseMount(daemonCfg)
	if !ok {
		r.Fail("BACKEND_DAEMON_CONFIG %q must be an absolute path, or daemon=local with two absolute paths", daemonCfg)
		return
	}
	cfg.DaemonConfig = m
	// A folder inside another would be walked twice, and the config folder
	// inside a data root would list the daemon's own settings as orphans.
	all := append(append([]Mount(nil), cfg.DataRoots...), m)
	for i := range all {
		for j := range all {
			if i == j {
				continue
			}
			for _, side := range [][2]string{{all[i].Daemon, all[j].Daemon}, {all[i].Local, all[j].Local}} {
				if within(side[0], side[1]) {
					r.Fail("orphan finder folders must not overlap: %s is inside %s", side[0], side[1])
				}
			}
		}
	}
}

func parseMount(raw string) (Mount, bool) {
	d, l, mapped := strings.Cut(raw, "=")
	if !mapped {
		l = d
	}
	d, l = strings.TrimSpace(d), strings.TrimSpace(l)
	if !path.IsAbs(d) || !path.IsAbs(l) {
		return Mount{}, false
	}
	return Mount{Daemon: path.Clean(d), Local: path.Clean(l)}, true
}

// within reports whether p is q or sits below it.
func within(p, q string) bool {
	return p == q || strings.HasPrefix(p, strings.TrimSuffix(q, "/")+"/")
}

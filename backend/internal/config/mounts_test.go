package config

import (
	"strings"
	"testing"
)

func formEnv(extra map[string]string) map[string]string {
	e := map[string]string{
		"BACKEND_AUTH_MODE":     "form",
		"PUBLIC_FQDN":           "host.example",
		"TRANSMISSION_USER":     "u",
		"TRANSMISSION_PASSWORD": "p",
	}
	for k, v := range extra {
		e[k] = v
	}
	return e
}

func TestOrphanFinderOffByDefault(t *testing.T) {
	withEnv(t, formEnv(nil))
	cfg, err := Load()
	if err != nil || len(cfg.DataRoots) != 0 || cfg.DaemonConfig != (Mount{}) {
		t.Fatalf("off by default: %+v %v", cfg.DataRoots, err)
	}
}

func TestOrphanFinderMounts(t *testing.T) {
	withEnv(t, formEnv(map[string]string{
		"BACKEND_DATA_ROOTS":    "/data/torrents/, /downloads=/mnt/dl",
		"BACKEND_DAEMON_CONFIG": "/config",
	}))
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	want := []Mount{{"/data/torrents", "/data/torrents"}, {"/downloads", "/mnt/dl"}}
	if len(cfg.DataRoots) != 2 || cfg.DataRoots[0] != want[0] || cfg.DataRoots[1] != want[1] {
		t.Fatalf("roots: %+v", cfg.DataRoots)
	}
	if cfg.DaemonConfig != (Mount{"/config", "/config"}) {
		t.Fatalf("config: %+v", cfg.DaemonConfig)
	}
}

func TestOrphanFinderRefusals(t *testing.T) {
	for _, tc := range []struct {
		name  string
		env   map[string]string
		wants string
	}{
		{"roots alone", map[string]string{"BACKEND_DATA_ROOTS": "/data"}, "go together"},
		{"config alone", map[string]string{"BACKEND_DAEMON_CONFIG": "/config"}, "go together"},
		{"relative root", map[string]string{"BACKEND_DATA_ROOTS": "data", "BACKEND_DAEMON_CONFIG": "/config"}, "absolute"},
		{"relative mapping", map[string]string{"BACKEND_DATA_ROOTS": "/data=mnt", "BACKEND_DAEMON_CONFIG": "/config"}, "absolute"},
		{"relative config", map[string]string{"BACKEND_DATA_ROOTS": "/data", "BACKEND_DAEMON_CONFIG": "config"}, "absolute"},
		{"nested roots", map[string]string{"BACKEND_DATA_ROOTS": "/data,/data/inc", "BACKEND_DAEMON_CONFIG": "/config"}, "overlap"},
		{"config inside a root", map[string]string{"BACKEND_DATA_ROOTS": "/data", "BACKEND_DAEMON_CONFIG": "/data/config"}, "overlap"},
		{"locals overlap", map[string]string{"BACKEND_DATA_ROOTS": "/a=/mnt,/b=/mnt/b", "BACKEND_DAEMON_CONFIG": "/config"}, "overlap"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withEnv(t, formEnv(tc.env))
			if _, err := Load(); err == nil || !strings.Contains(err.Error(), tc.wants) {
				t.Fatalf("want %q, got %v", tc.wants, err)
			}
		})
	}
}

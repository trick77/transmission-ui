.PHONY: check hooks lint fe-test fe-coverage fe-build fe-e2e build dev fixtures sim sim-server

# The gate: everything CI checks, configured in ship.yaml. Master's ship, as the pre-push hook and the @master
# workflows run it: its sha asked of GitHub (a proxy lags on @master). A local ship: SHIP_CMD=<go-installed binary>,
# one name for here and the hook, so make check and the push gate never run different ships.
SHIP_CMD ?= sha=$$(git ls-remote https://github.com/trick77/ship refs/heads/master | cut -f1); \
	[ -n "$$sha" ] || { echo "cannot resolve ship's master on GitHub (git ls-remote, error above)"; exit 1; }; \
	go run github.com/trick77/ship@$$sha

check:
	$(SHIP_CMD) check

hooks:
	$(SHIP_CMD) hooks

# Quick lint while editing, at the golangci-lint version check runs.
lint:
	$(SHIP_CMD) lint

dev:
	docker compose -f compose.dev.yaml up -d
	cd ui && npm run dev

fixtures:
	./scripts/fixtures.sh

# Dev server against ui/sim/, the fake daemon. No container, no fixtures. Needs Node >= 23.6.
# Knobs: TM_SIM_SEED, TM_SIM_COUNT, TM_SIM_SPEED, TM_SIM_PORT.
sim:
	node ui/sim/server.ts & pid=$$!; trap 'kill $$pid 2>/dev/null' EXIT INT TERM; \
	cd ui && TM_RPC_TARGET=http://localhost:$${TM_SIM_PORT:-9092} TM_RPC_AUTH= npm run dev

# Just the fake daemon, for curl or a second UI process.
sim-server:
	node ui/sim/server.ts

fe-test:
	cd ui && npm run test -- --run

fe-coverage:
	cd ui && npm run test -- --run --coverage

fe-e2e:
	cd ui && npm run e2e

# main.go embeds backend/dist: rsync --delete, a plain cp keeps stale hashed bundles, which get embedded.
fe-build:
	cd ui && npm ci && npm run build
	rsync -a --delete ui/dist/ backend/dist/

build: fe-build

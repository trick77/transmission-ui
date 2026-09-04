.PHONY: fe-test fe-coverage fe-build fe-e2e coverage build dev fixtures sim sim-server

dev:
	docker compose -f compose.dev.yaml up -d
	cd ui && npm run dev

fixtures:
	./hack/fixtures.sh

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
	./hack/coverage-gate.sh ui

fe-e2e:
	cd ui && npm run e2e

coverage: fe-coverage

fe-build:
	cd ui && npm ci && npm run build

build: fe-build

.PHONY: fe-test fe-coverage fe-build fe-e2e coverage build dev fixtures

dev:
	docker compose -f compose.dev.yaml up -d
	cd ui && npm run dev

fixtures:
	./hack/fixtures.sh

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

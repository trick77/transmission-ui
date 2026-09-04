# transmission-ui

Web client for transmission-daemon. Static bundle served by the daemon itself.

## Layout
- `design/` locked mockups = the spec. `design/build.sh` assembles them from `design/src/`.
- `ui/` Vite + React 19 + TS, plain CSS. `ui/src/styles/app.css` is ported from `design/src/head.html`: edit the mock first, then copy the `<style>` block over (fonts → `../assets/fonts/`).
- `hack/` local daemon state, `fixtures.sh` (seeds every torrent state), `coverage-gate.sh` + `coverage-floors`.
- `ui/sim/` standalone fake daemon (`node ui/sim/server.ts`, `:9092`). Node runs it with built-in type stripping, so keep it erasable: no enum, no parameter properties, `.ts` on every relative import, `import type { … }` in statement form only.
- `compose.yaml` = production stack (Containerfile image, `.env` from `.env.example`). `compose.dev.yaml` = throwaway local daemon.

## Daemon
- Target = **4.0.5 (rpc-version 17)**. 4.0.6 / 4.1.0 / 4.1.1 got blacklisted by trackers; never suggest upgrading without the user's say-so. Features needing rpc ≥ 18 (sequential download) hide themselves.
- Real daemon: Docker on the user's server, RPC user/pass, direct `:9091`. Never point tests, fixtures or compose at it.
- Local: `docker compose -f compose.dev.yaml up -d` → `lscr.io/linuxserver/transmission:4.0.5-r3-ls240` on `:9091`, creds `dev:devpass`, state in `hack/state`. Seed with `hack/fixtures.sh`.

## Dev / test / ship
- `make dev` or `cd ui && npm run dev` → `:5173`, proxies `/transmission/rpc`. Target/auth from `ui/.env.local` (gitignored; see `ui/.env.example`); default = local daemon.
- `make sim` → dev server against `ui/sim/`, no container, no fixtures. Needs Node ≥ 23.6. ~29 torrents that actually move; knobs `TM_SIM_SEED`, `TM_SIM_COUNT`, `TM_SIM_SPEED` (0 freezes, 30 races), `TM_SIM_PORT`. Dataset names stay copyright-safe: distros, Blender open movies, documented PD/CC0, NASA, open data dumps.
- Gates: `npm run typecheck`, `npm run build`, `make fe-coverage` (Vitest v8 → `coverage/ui`, floor in `hack/coverage-floors`, currently 75 % lines). No eslint/prettier unless asked.
- Unit + component tests: `ui/src/**/*.test.{ts,tsx}`, jsdom + @testing-library. Components run against `ui/src/test/fakeDaemon.ts` (in-memory RPC behind `fetch`); assert on the RPC calls it records, not on internals. New source file → a test that imports it, coverage `include` counts untested files.
- e2e: `make fe-e2e` (Playwright, needs dev server + seeded local daemon; `e2e/served.spec.ts` needs `npm run build`). Screenshots in `ui/test-results/`.
- Visible change → drive the running app, compare to `design/*.html` in Safari.
- Ship: `npm run build` → rsync `ui/dist` to the server → mount at `/web`, `TRANSMISSION_WEB_HOME=/web`, restart. Rollback = unset the var. Or `docker compose up -d --build` with `compose.yaml` for the self-contained image.

## Conventions
- All RPC calls go through `ui/src/rpc/methods.ts`; field names are the daemon's (camelCase torrent fields, kebab session keys).
- Derived views (filters, sort, folders, tracker health) live in `ui/src/lib/model.ts`, mirrored from `design/src/rows.html`.
- Bulk actions = one RPC with an id array. Remove vs remove+delete are always two separate, differently worded actions.
- Colour rules: accent only for active download + controls, red only for errors, everything else neutral.
- Node ≥ 22 ships a fake `localStorage` global: `ui/src/test-setup.ts` replaces it; don't remove that.
- `compose.yaml` / `Containerfile` naming; git default branch `master`; no remote yet.

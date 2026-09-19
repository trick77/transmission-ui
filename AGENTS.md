# transmission-ui

Web client for transmission-daemon. Static bundle served by the daemon itself.

## Layout
- `design/` locked mockups = the spec. `design/build.sh` assembles them from `design/src/`.
- `ui/` Vite + React 19 + TS, plain CSS. `ui/src/styles/app.css` is ported from `design/src/head.html`: edit the mock first, then copy the `<style>` block over (fonts → `../assets/fonts/`).
- `hack/` local daemon state, `fixtures.sh` (seeds every torrent state), `coverage-gate.sh` + `coverage-floors`.
- `ui/sim/` standalone fake daemon (`node ui/sim/server.ts`, `:9092`). Node runs it with built-in type stripping, so keep it erasable: no enum, no parameter properties, `.ts` on every relative import, `import type { … }` in statement form only.
- `backend/` Go: serves the embedded `ui/dist`, OIDC RP at `/api/auth/*` (signed-cookie session, no DB), reverse-proxies `/transmission/rpc` to the daemon with its basic auth attached. Ported from peeq's `internal/auth`.
- Auth modes (`BACKEND_AUTH_MODE`): `oidc` | `form` (server-rendered `/login`, checks `TM_USER`/`TM_PASS`). Local work uses `form`; there is no auto-login mode. An upstream 401 becomes a 502, never a passthrough: forwarding `WWW-Authenticate` would pop the browser dialog the backend exists to remove.
- A path in `BACKEND_PUBLIC_URL` is the prefix the proxy forwards (it is NOT stripped); every route mounts under it and every redirect keeps it.
- `compose.yaml` = production stack (Containerfile image, `.env` from `.env.example`). `compose.dev.yaml` = throwaway local daemon.

## Daemon
- Target = **4.1.3** (`rpc_version` 19, `rpc_version_semver` 6.0.1). JSON-RPC 2.0 envelope, snake_case keys, no 4.0.x compatibility. A version that trackers blacklist shows as "client rejected" in the sidebar within one announce cycle.
- Real daemon: Docker on the user's server, RPC user/pass, direct `:9091`. Never point tests, fixtures or compose at it.
- Local: `docker compose -f compose.dev.yaml up -d` → `lscr.io/linuxserver/transmission:4.1.3-r0-ls360` on `:9091`, creds `dev:devpass`, state in `hack/state`. Seed with `hack/fixtures.sh`.

## Dev / test / ship
- `make dev` or `cd ui && npm run dev` → `:5173`, proxies `/transmission/rpc`. Target/auth from `ui/.env.local` (gitignored; see `ui/.env.example`); default = local daemon.
- `make sim` → dev server against `ui/sim/`, no container, no fixtures. Needs Node ≥ 23.6. ~29 torrents that actually move; knobs `TM_SIM_SEED`, `TM_SIM_COUNT`, `TM_SIM_SPEED` (0 freezes, 30 races), `TM_SIM_PORT`. Dataset names stay copyright-safe: distros, Blender open movies, documented PD/CC0, NASA, open data dumps.
- Gates: `npm run typecheck`, `npm run build`, `make fe-coverage` (Vitest v8 → `coverage/ui`, floor in `hack/coverage-floors`, currently 75 % lines). No eslint/prettier unless asked.
- Unit + component tests: `ui/src/**/*.test.{ts,tsx}`, jsdom + @testing-library. Components run against `ui/src/test/fakeDaemon.ts` (in-memory RPC behind `fetch`); assert on the RPC calls it records, not on internals. New source file → a test that imports it, coverage `include` counts untested files.
- e2e: `make fe-e2e` (Playwright, needs dev server + seeded local daemon; `e2e/served.spec.ts` needs `npm run build`). Screenshots in `ui/test-results/`.
- Visible change → drive the running app, compare to `design/*.html` in Safari.
- Ship: `docker compose up -d --build` with `compose.yaml`. The image is UI + backend and contains no daemon; `TM_RPC_UPSTREAM` points at one. Bundle-only path still works (rsync `ui/dist`, mount at `/web`, `TRANSMISSION_WEB_HOME=/web`) but has no OIDC.
- Backend gates: `npm run build` in `ui/` first, then `cp -R ui/dist/. backend/dist/` — `main.go` embeds the bundle and `backend/dist/` is gitignored, so a fresh checkout cannot build without it. Then `cd backend && go vet ./... && go test ./...`. Local run: `hack/backend.sh` (form mode against the compose daemon).

## Conventions
- All RPC calls go through `ui/src/rpc/methods.ts`; method and field names are the daemon's, snake_case throughout (rpc 18+). Take spellings from the upstream `docs/rpc-spec.md`, never from memory.
- Derived views (filters, sort, folders, tracker health) live in `ui/src/lib/model.ts`, mirrored from `design/src/rows.html`.
- Bulk actions = one RPC with an id array. Remove vs remove+delete are always two separate, differently worded actions.
- Colour rules: accent only for active download + controls, red only for errors, everything else neutral.
- Node ≥ 22 ships a fake `localStorage` global: `ui/src/test-setup.ts` replaces it; don't remove that.
- `compose.yaml` / `Containerfile` naming; default branch `master`; remote `trick77/transmission-ui` — CI on PRs, image + release on master push.

# transmission-ui

Web client for transmission-daemon. Static bundle served by the daemon itself.

## Layout
- `design/` locked mockups = the spec. `design/build.sh` assembles them from `design/src/`.
- `ui/` Vite + React 19 + TS, plain CSS. `ui/src/styles/app.css` is ported from `design/src/head.html`: edit the mock first, then copy the `<style>` block over (fonts → `../assets/fonts/`).
- `hack/` local daemon state, `fixtures.sh` (seeds every torrent state), `coverage-gate.sh` + `coverage-floors`.
- `ui/sim/` standalone fake daemon (`node ui/sim/server.ts`, `:9092`). Node runs it with built-in type stripping, so keep it erasable: no enum, no parameter properties, `.ts` on every relative import, `import type { … }` in statement form only.
- `backend/` Go: serves the embedded `ui/dist`, OIDC RP at `/api/auth/*` (signed-cookie session, no DB), reverse-proxies `/transmission/rpc` to the daemon with its basic auth attached. Ported from peeq's `internal/auth`.
- Auth modes (`BACKEND_AUTH_MODE`): `oidc` | `form` (server-rendered `/login`, checks `TM_USER`/`TM_PASS`). Local work uses `form`; there is no auto-login mode. The app shell is gated in both: signed out, form mode 302s to `/login` and oidc renders the same card without the form. The check sits inside `staticHandler` after the SPA-fallback switch, NOT on the `GET /` route -- every unknown extensionless path is rewritten to index.html, so gating the route alone leaves the shell reachable at `/settings` or any deep link. It answers **200, never 4xx** -- the container healthcheck probes that exact route and counts >= 400 as unhealthy. `/login`, `POST /login` and `/login-assets/` mount in every mode; the POST 404s outside form mode. An upstream 401 becomes a 502, never a passthrough: forwarding `WWW-Authenticate` would pop the browser dialog the backend exists to remove.
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
- Derived views (filters, sort, folders, tracker health) live in `ui/src/lib/model.ts`, mirrored from `design/src/rows.html`. One Error filter covers both a daemon error and a failing tracker; `filterFn` still maps the retired `trackererr` key onto it so old links work.
- Bulk actions = one RPC with an id array. Remove vs remove+delete are always two separate, differently worded actions. Remove+delete is the default (⌫, sel-bar button, first menu entry); remove-only is ⌘⌫. Do not "fix" that inversion.
- **Exception: remove+delete sends one `torrent_remove` per torrent** (`removeSequence`, `state/store.ts`). `torrent-remove` is a sync handler on the daemon's session thread and the RPC server shares that event loop, so while it unlinks it answers nothing -- polls included -- and its 200 means the files are gone, not that it started. One call with 10 ids = one opaque freeze; one call each = real progress (`.rm-bar` pill, `.row.pending`). Cost is O(file count), not bytes. The loop lives in the browser, so closing the tab mid-run leaves the rest. Remove-from-list stays one call; it never touches the disk. Failed rows and the summary persist until dismissed -- never let a failed removal vanish silently.
- Colour rules: accent only for active download + controls, red only for errors, everything else neutral.
- Row grids come in pairs: a `grid-template-columns` change needs the matching `>:nth-child(n+N){display:none}`, or leftover cells auto-place into an implicit second row and double the row height. Two-line rows have 8 children, compact 11. Below 1200px the tail columns drop (at 1194px Name was at its 180px floor, 24 of 29 names clipped).
- No `text-transform:uppercase` anywhere: headings and table headers are sentence case, no tracking (`.side-h` 14px/400, `.cols`/`.tbl th`/`.pop th` 12px/500, `.sec` 13px/500). Label strings are already written in sentence case; the CSS was shouting them. `.side-h` and `.sec` are shared with Settings and Add.
- Node ≥ 22 ships a fake `localStorage` global: `ui/src/test-setup.ts` replaces it; don't remove that.
- `compose.yaml` / `Containerfile` naming; default branch `master`; remote `trick77/transmission-ui` — CI on PRs, image + release on master push.

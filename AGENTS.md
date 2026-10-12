# transmission-ui

## Layout
- `design/` mockups = spec. CSS: edit mock (`design/src/head.html`) first, copy `<style>` to `ui/src/styles/app.css` (fonts → `../assets/fonts/`), `npm run format`.
- `ui/sim/` fake daemon, Node type stripping: no enum, no parameter properties, `.ts` on relative imports, `import type` statement form only.
- `backend/`: kit / kit/auth for shell, sessions, OIDC, env, logging, probes, errors; no own copies. Errors `httpx.WriteError` `{"error"}` (UI banner reads it). `<base>/healthz` 2xx only; `<base>/readyz` = daemon RPC answers. `BACKEND_SESSION_SECRET` ≥ 32 bytes. Empty env = unset.
- Auth (`BACKEND_AUTH_MODE`): `oidc` | `form` (`TRANSMISSION_USER`/`TRANSMISSION_PASSWORD`); no auto-login. Gate = `kit/spa` `Gate` on every shell answer, NOT the `GET /` route (unknown paths get the shell: `/settings` would leak). Shell, login, RPC all judge by `Sessions.Authorize`. Signed out: **200 (oidc card) or 302 (form), never 4xx**. `/login`, `POST /login`, `/login-assets/` mount in every mode; POST 404s outside form. Upstream 401 → 502, never passthrough (`WWW-Authenticate` pops the browser dialog).
- `BACKEND_PUBLIC_URL` path = prefix the proxy forwards, NOT stripped; every route and redirect keeps it. Must be https; loopback http only exception.
- `compose.yaml` proxy-agnostic: no published port, no proxy config; never add one. `compose.dev.yaml` = throwaway daemon.

## Daemon
- Target **4.1.3** (`rpc_version` 19, semver 6.0.1). JSON-RPC 2.0, snake_case, no 4.0.x compat.
- Real daemon (user's server, `:9091`): never point tests, fixtures or compose at it.
- Local: `docker compose -f compose.dev.yaml up -d`, creds `dev:devpass`, seed `scripts/fixtures.sh`.

## Dev / test / ship
- `make dev` → `:5173`; target/auth from `ui/.env.local`. `make sim` needs Node ≥ 23.6; knobs `TM_SIM_SEED`, `TM_SIM_COUNT`, `TM_SIM_SPEED`, `TM_SIM_PORT`. Sim names copyright-safe: distros, Blender, PD/CC0, NASA, open data.
- Gate `make check` (ship master unpinned; local `SHIP_CMD=<binary>`). 75 % floors + patch. `make hooks` once per clone. GitHub never first to find a failure. `[skip patch-coverage]` skips patch only. `sim/`, `e2e/` linted, not prettier-formatted.
- Commit subjects + PR titles: Go style `area: what` (`ui: …`, `backend: …`, `sim: …`, `design: …`, `ci: …`), gated by ship; release notes list them by area.
- Tests against `ui/src/test/fakeDaemon.ts`; assert recorded RPC calls, not internals. New source file → a test importing it (coverage counts untested files).
- e2e not in CI or gate: `make fe-e2e` by hand before a UI-behaviour PR.
- Visible change → drive the running app, compare to `design/*.html` in Safari.
- Release by hand only: `gh workflow run Release -f bump=patch`. Merges ship nothing. Ship's master is the only guard.
- `backend/dist`: vite outDir, tracked `.gitkeep` only (`emptyOutDir: false`, vite config clears the rest). Binary refuses to start without `index.html`: `make fe-build` first. Local run `scripts/backend.sh`.

## Conventions
- All RPC via `ui/src/rpc/methods.ts`; daemon's snake_case names, spellings from upstream `docs/rpc-spec.md`, never memory.
- Derived views in `ui/src/lib/model.ts`. One Error filter = daemon error + failing tracker; `filterFn` maps retired `trackererr` onto it.
- Bulk = one RPC with id array. Remove vs remove+delete: always two differently worded actions; remove+delete is default (⌫), remove-only ⌘⌫. Do not "fix" that inversion.
- **Remove+delete = one `torrent_remove` per torrent** (`removeSequence`): sync on the daemon's session thread, answers nothing while it unlinks (polls included), 200 = files gone; cost O(file count). Closing the tab mid-run leaves the rest. Remove-from-list stays one call. Failed rows persist until dismissed, never vanish silently.
- New inspector field → `EXTRA_FIELDS` or `EXTRA_LIVE`, else it never refreshes.
- Empty delta leaves `torrents`/`byId` untouched (every 5th tick renews the array, for clock-driven tracker health); `List` hands `Row` stable props (`rowMemo.test.tsx`). Never mutate a row (`perRow` cache).
- Only hashed `/assets/*` is `immutable`; unversioned names get ETag + `no-cache`. No compression in the backend.
- `POST /login` + RPC proxy behind `http.CrossOriginProtection`. Logout stays GET. Form mode ignores `BACKEND_OIDC_ALLOWED_GROUP`.
- Colour: accent only active download + controls, red only errors, rest neutral.
- Row grids in pairs: a `grid-template-columns` change needs the matching `>:nth-child(n+N){display:none}` (two-line 8 children, compact 11), else row height doubles. Below 1200px tail columns drop (at 1194px 24 of 29 names clipped).
- No `text-transform:uppercase`: sentence case, no tracking.
- `ui/src/test/setup.ts` replaces Node ≥ 22's fake `localStorage`; keep it.

# transmission-ui

A web client for transmission-daemon, with a backend that signs users in and keeps the daemon's
credentials off the browser. React 19 + TypeScript, Go, no database.

![Torrent list](docs/screenshot-list.png)

Selecting a torrent opens an inspector with progress, pieces, transfer numbers, files, peers and
per-tracker announce state.

![Torrent detail](docs/screenshot-detail.png)

## Requirements

transmission-daemon **4.1.x**. The UI speaks JSON-RPC 2.0 with snake_case keys (`rpc_version` 18+)
and does not talk to the 4.0.x protocol.

## How it works

`ghcr.io/trick77/transmission-ui` is the UI bundle embedded in a Go binary. The binary serves the
bundle, terminates the login, and reverse-proxies `/transmission/rpc` to your daemon with the
daemon's basic auth attached. The browser never sees those credentials, and an unauthenticated RPC
call gets a 401 rather than a native auth dialog.

The image contains **no daemon**. Point `TM_RPC_UPSTREAM` at one; it keeps its own RPC port for
`transmission-remote` and the *arr apps, which go on using basic auth directly.

## Install

```
cp .env.example .env     # fill in TM_*, the auth block, and the session secret
docker compose up -d
```

`compose.yaml` is a working stack behind an external Traefik that terminates TLS.

### Signing in

`BACKEND_AUTH_MODE` picks one:

- **`form`** — a login page that accepts the daemon's own RPC credentials (`TM_USER` / `TM_PASS`).
  Nothing extra to provision, and what local development uses.
- **`oidc`** — an identity provider. Register a confidential client with redirect URI
  `<BACKEND_PUBLIC_URL>/api/auth/callback`, request the `groups` scope, and optionally gate access
  on `BACKEND_OIDC_ALLOWED_GROUP`.

Logout clears the local session; it does not end the session at the identity provider.

### Behind a path prefix

Set `BACKEND_PUBLIC_URL` to the full external URL, including any path:

```
BACKEND_PUBLIC_URL=https://seedbox.example.com/transmission
```

Every route then mounts under that prefix. The reverse proxy must forward it, not strip it.

### Bundle only

The release also ships `transmission-ui-<version>.zip`: unzip it, mount it at `/web`, set
`TRANSMISSION_WEB_HOME=/web`, restart the daemon. Unsetting the variable puts the stock UI back.
This path has no backend, so the daemon's own basic auth applies and there is no OIDC.

## Development

```
docker compose -f compose.dev.yaml up -d   # throwaway daemon on :9091, dev/devpass
hack/fixtures.sh                           # seed every torrent state the UI shows
cd ui && npm ci && npm run dev             # http://localhost:5173
```

`hack/backend.sh` builds and runs the real backend against that daemon in form mode, which is what
`ui/e2e/backend.spec.ts` drives. `make sim` runs the UI against `ui/sim/`, an in-process fake
daemon, when you don't want a container — the screenshots above come from it, so the torrents in
them are made up.

See `AGENTS.md` for layout, test gates and conventions.

## Licence

MIT. See `LICENSE`.

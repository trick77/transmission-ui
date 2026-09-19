# transmission-ui

A web client for transmission-daemon: a static bundle the daemon serves itself, in place of its
built-in web UI. React 19 + TypeScript, no runtime dependencies beyond the daemon's RPC.

![Torrent list](docs/screenshot-list.png)

Selecting a torrent opens an inspector with progress, pieces, transfer numbers, files, peers and
per-tracker announce state.

![Torrent detail](docs/screenshot-detail.png)

## Requirements

transmission-daemon **4.1.x**. The UI speaks JSON-RPC 2.0 with snake_case keys (`rpc_version` 18+)
and does not talk to the 4.0.x protocol.

## Install

Two ways in, both from the release:

**Container image** — the UI plus a small Go backend:

```
ghcr.io/trick77/transmission-ui:latest
```

The backend serves the bundle, signs users in, and proxies `/transmission/rpc` to a daemon you run
separately, attaching the daemon's basic auth upstream so the browser never sees it. The image
contains no daemon: point `TM_RPC_UPSTREAM` at yours, which keeps `:9091` for radarr/sonarr and
`transmission-remote`.

Two ways to sign in, set by `BACKEND_AUTH_MODE`:

- `oidc` — an identity provider. Register a confidential client with redirect URI
  `https://<host>/api/auth/callback`, and optionally gate access on a group with
  `BACKEND_OIDC_ALLOWED_GROUP`.
- `form` — a login page that accepts the daemon's own RPC credentials (`TM_USER` / `TM_PASS`).
  Nothing extra to provision: whoever may drive `transmission-remote` may drive the web UI.

`compose.yaml` in this repo is a working stack behind an external Traefik, which terminates TLS for
either mode. Copy `.env.example` to `.env` first.

**Bundle only** — mount it into a daemon you already run:

1. Download `transmission-ui-<version>.zip` from the [releases](https://github.com/trick77/transmission-ui/releases) and unzip it somewhere the daemon can read.
2. Mount it at `/web` and set `TRANSMISSION_WEB_HOME=/web`.
3. Restart the daemon. Unsetting the variable puts the stock UI back.

This path has no OIDC: the daemon serves the bundle and its own basic auth applies.

## Development

```
docker compose -f compose.dev.yaml up -d   # throwaway daemon on :9091, dev/devpass
hack/fixtures.sh                           # seed every torrent state the UI shows
cd ui && npm ci && npm run dev             # http://localhost:5173
```

`make sim` runs the UI against `ui/sim/`, an in-process fake daemon, when you don't want a
container. The screenshots above come from it, so the torrents in them are made up.

See `AGENTS.md` for layout, test gates and conventions.

## Licence

MIT. See `LICENSE`.

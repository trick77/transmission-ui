# The shipped image: the UI bundle embedded in a Go binary that terminates OIDC
# and proxies RPC to a transmission-daemon running elsewhere. It does NOT
# contain a daemon; point TM_RPC_UPSTREAM at yours.
FROM node:26-alpine AS ui
WORKDIR /src
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
RUN npm run build

FROM golang:1.27-alpine AS backend
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
# The bundle is embedded (//go:embed all:dist), so it has to be in place before
# the build, not copied into the runtime image.
COPY --from=ui /src/dist ./dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/transmission-ui .

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=backend /out/transmission-ui /transmission-ui
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/transmission-ui"]

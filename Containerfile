# The shipped image: the UI bundle embedded in a Go binary that terminates OIDC
# and proxies RPC to a transmission-daemon running elsewhere. It does NOT
# contain a daemon; point TRANSMISSION_RPC_UPSTREAM at yours.
FROM node:26-alpine AS ui
WORKDIR /src/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
# vite writes into ../backend/dist (the Go embed directory).
RUN npm run build

FROM golang:1.27-alpine AS backend
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
# The bundle is embedded (//go:embed all:dist), so it has to be in place before
# the build, not copied into the runtime image.
COPY --from=ui /src/backend/dist ./dist
# Declared in this stage: an ARG is scoped to the stage it is declared in, and
# one declared elsewhere leaves ${VERSION} empty here without a word.
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w -X github.com/trick77/ship/kit/version.Version=${VERSION}" \
    -o /out/transmission-ui .

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=backend /out/transmission-ui /transmission-ui
EXPOSE 8080
ENTRYPOINT ["/transmission-ui"]

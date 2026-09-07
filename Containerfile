# Optional: a daemon image with this UI baked in. The documented ship path mounts ui/dist instead
# (see docs); this is for the case where a self-contained image is easier to deploy.
FROM node:26-alpine AS build
WORKDIR /src
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
RUN npm run build

FROM lscr.io/linuxserver/transmission:4.1.3-r0-ls360
COPY --from=build /src/dist /web
ENV TRANSMISSION_WEB_HOME=/web

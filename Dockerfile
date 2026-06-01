# syntax=docker/dockerfile:1.7

# ZenNotes self-hosted build from the monorepo.
#
# Stages:
#   1. web-build     -> npm workspace install + Vite build for apps/web
#   2. server-build  -> Go build for apps/server with the web bundle embedded
#   3. runtime       -> minimal image with only the server binary

# Base images pinned by digest. Refresh with Renovate/Dependabot or by
# running `docker inspect --format='{{index .RepoDigests 0}}' <image>`
# after a deliberate `docker pull` of the desired floating tag.
# web-build emits a platform-agnostic static bundle, so always run it on the
# native build platform (never under emulation) regardless of the target arch.
FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS web-build
WORKDIR /app

COPY package.json package-lock.json turbo.json tsconfig.base.json tsconfig.json tailwind.config.js postcss.config.js ./
COPY apps/web/package.json apps/web/package.json
COPY packages/app-core/package.json packages/app-core/package.json
COPY packages/bridge-contract/package.json packages/bridge-contract/package.json
COPY packages/shared-domain/package.json packages/shared-domain/package.json
COPY packages/shared-ui/package.json packages/shared-ui/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/server/package.json apps/server/package.json

RUN npm ci --no-audit --no-fund --loglevel=error

COPY apps apps
COPY packages packages

RUN npm run build --workspace @zennotes/web

# Run the Go toolchain on the native build platform and cross-compile to the
# target arch (CGO is off, so this is a fast pure-Go cross-build — no QEMU).
FROM --platform=$BUILDPLATFORM golang:1.22-alpine@sha256:1699c10032ca2582ec89a24a1312d986a3f094aed3d5c1147b19880afe40e052 AS server-build
WORKDIR /app

COPY apps/server/go.mod apps/server/go.sum ./apps/server/
WORKDIR /app/apps/server
RUN go mod download

WORKDIR /app
COPY apps/server apps/server
COPY --from=web-build /app/apps/web/dist/ /app/apps/server/web/dist/

# TARGETARCH is provided by buildx (e.g. amd64, arm64) for the image being built.
ARG TARGETARCH
ENV CGO_ENABLED=0 \
    GOOS=linux \
    GOARCH=$TARGETARCH \
    GOFLAGS=-trimpath

WORKDIR /app/apps/server
RUN go build -ldflags="-s -w" -o /out/zennotes-server ./cmd/zennotes-server

FROM scratch
LABEL org.opencontainers.image.title="ZenNotes" \
      org.opencontainers.image.description="Self-hosted ZenNotes web/server bundle from the monorepo." \
      org.opencontainers.image.source="https://github.com/ZenNotes/zennotes"

COPY --from=server-build /out/zennotes-server /zennotes-server

ENV ZENNOTES_BIND=0.0.0.0:7878 \
    ZENNOTES_CONFIG_PATH=/data/server.json \
    ZENNOTES_DEFAULT_VAULT_PATH=/workspace \
    ZENNOTES_BROWSE_ROOTS=/workspace

USER 65532:65532

EXPOSE 7878
VOLUME ["/workspace", "/data"]

ENTRYPOINT ["/zennotes-server"]

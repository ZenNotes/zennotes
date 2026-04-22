# syntax=docker/dockerfile:1.7

# ZenNotes self-hosted build from the monorepo.
#
# Stages:
#   1. web-build     -> npm workspace install + Vite build for apps/web
#   2. server-build  -> Go build for apps/server with the web bundle embedded
#   3. runtime       -> minimal image with only the server binary

FROM node:22-alpine AS web-build
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

FROM golang:1.22-alpine AS server-build
WORKDIR /app

COPY apps/server/go.mod apps/server/go.sum ./apps/server/
WORKDIR /app/apps/server
RUN go mod download

WORKDIR /app
COPY apps/server apps/server
COPY --from=web-build /app/apps/web/dist/ /app/apps/server/web/dist/

ENV CGO_ENABLED=0 \
    GOOS=linux \
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

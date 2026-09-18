IMAGE ?= adibhanna/zennotes:latest
PORT ?= 7878
CONTENT_ROOT ?= ./vault
DATA ?= ./data
APP_URL ?= http://localhost:$(PORT)
ALLOW_INSECURE_NOAUTH ?= 0
COMPOSE := $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")
OPEN_BROWSER := $(shell command -v open 2>/dev/null || command -v xdg-open 2>/dev/null)

.PHONY: help install dev desktop web-dev server-dev web-stack \
	build desktop-build web-build \
	up down restart logs status open rebuild nuke clean

help:
	@echo ""
	@echo "  Setup"
	@echo "    make install      — install npm workspace dependencies"
	@echo ""
	@echo "  Local development"
	@echo "    make desktop      — run the Electron desktop app in dev mode"
	@echo "    make web-dev      — run the Vite web client in dev mode"
	@echo "    make server-dev   — run the pinned ZenNotes/znserver release (or a checkout via ZENNOTES_SERVER_DIR)"
	@echo "    make web-stack    — run server + web dev together"
	@echo ""
	@echo "  Local builds"
	@echo "    make build        — build the full monorepo"
	@echo "    make desktop-build — build the Electron desktop app"
	@echo "    make web-build    — build apps/web"
	@echo ""
	@echo "  Docker"
	@echo "    make up       — start the self-hosted server from the published image"
	@echo "    make down     — stop the container"
	@echo "    make restart  — restart the container"
	@echo "    make logs     — follow logs"
	@echo "    make status   — show compose status"
	@echo "    make open     — open the app in your browser"
	@echo "    make rebuild  — pull the newest image and restart"
	@echo "    make nuke     — tear down and remove the image, data, and build output"
	@echo "    make clean    — remove local web build output and downloaded server binaries"
	@echo ""
	@echo "  Useful Docker vars"
	@echo "    CONTENT_ROOT=~/iCloud Drive/Obsidian   — host folder used as the live vault root"
	@echo "    PORT=7878                               — host port"
	@echo "    ALLOW_INSECURE_NOAUTH=1                 — opt out of generated auth token (not recommended)"
	@echo "    IMAGE=adibhanna/zennotes:2.50.5         — pin a published server image (default: latest)"
	@echo ""

install:
	npm ci

dev: desktop

desktop:
	npm run dev:desktop

web-dev:
	npm run dev:web

server-dev:
	npm run dev:server

web-stack:
	npm run dev:web-stack

build:
	npm run build

desktop-build:
	npm run build --workspace @zennotes/desktop

web-build:
	npm run build --workspace @zennotes/web

up:
	@mkdir -p "$(CONTENT_ROOT)" "$(DATA)"
	@ABS_CONTENT_ROOT="$$(cd "$(CONTENT_ROOT)" && pwd)"; \
	ABS_DATA="$$(cd "$(DATA)" && pwd)"; \
	AUTH_TOKEN=""; \
	if [ "$(ALLOW_INSECURE_NOAUTH)" != "1" ]; then \
		AUTH_TOKEN_FILE="$$ABS_DATA/auth-token"; \
		if [ ! -f "$$AUTH_TOKEN_FILE" ]; then \
			node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" > "$$AUTH_TOKEN_FILE"; \
			chmod 600 "$$AUTH_TOKEN_FILE"; \
		fi; \
		AUTH_TOKEN="$$(cat "$$AUTH_TOKEN_FILE")"; \
	fi; \
	ZENNOTES_IMAGE="$(IMAGE)" \
	ZENNOTES_HOST_PORT="$(PORT)" \
	ZENNOTES_HOST_CONTENT_ROOT="$$ABS_CONTENT_ROOT" \
	ZENNOTES_CONTAINER_CONTENT_ROOT="$$ABS_CONTENT_ROOT" \
	ZENNOTES_CONTAINER_DEFAULT_VAULT_PATH="$$ABS_CONTENT_ROOT" \
	ZENNOTES_BROWSE_ROOTS="$$ABS_CONTENT_ROOT" \
	ZENNOTES_ALLOWED_ORIGINS="http://localhost:$(PORT),http://127.0.0.1:$(PORT)" \
	ZENNOTES_AUTH_TOKEN="$$AUTH_TOKEN" \
	ZENNOTES_ALLOW_INSECURE_NOAUTH="$(ALLOW_INSECURE_NOAUTH)" \
	ZENNOTES_HOST_DATA="$$ABS_DATA" \
	ZENNOTES_CONTAINER_UID="$$(id -u)" \
	ZENNOTES_CONTAINER_GID="$$(id -g)" \
	$(COMPOSE) up -d
	@printf "\nZenNotes is running at $(APP_URL)\n\n"
ifneq ($(ALLOW_INSECURE_NOAUTH),1)
	@printf "Auth token: $(DATA)/auth-token\n\n"
endif
ifneq ($(strip $(OPEN_BROWSER)),)
	@$(OPEN_BROWSER) $(APP_URL) >/dev/null 2>&1 || true
endif

down:
	@$(COMPOSE) down

restart:
	@$(COMPOSE) restart zennotes 2>/dev/null || $(MAKE) --no-print-directory up

logs:
	@$(COMPOSE) logs -f

status:
	@$(COMPOSE) ps

open:
ifneq ($(strip $(OPEN_BROWSER)),)
	@$(OPEN_BROWSER) $(APP_URL)
else
	@echo "Open $(APP_URL) manually."
endif

rebuild:
	@mkdir -p "$(CONTENT_ROOT)" "$(DATA)"
	@ABS_CONTENT_ROOT="$$(cd "$(CONTENT_ROOT)" && pwd)"; \
	ABS_DATA="$$(cd "$(DATA)" && pwd)"; \
	AUTH_TOKEN=""; \
	if [ "$(ALLOW_INSECURE_NOAUTH)" != "1" ]; then \
		AUTH_TOKEN_FILE="$$ABS_DATA/auth-token"; \
		if [ ! -f "$$AUTH_TOKEN_FILE" ]; then \
			node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" > "$$AUTH_TOKEN_FILE"; \
			chmod 600 "$$AUTH_TOKEN_FILE"; \
		fi; \
		AUTH_TOKEN="$$(cat "$$AUTH_TOKEN_FILE")"; \
	fi; \
	ZENNOTES_IMAGE="$(IMAGE)" \
	ZENNOTES_HOST_PORT="$(PORT)" \
	ZENNOTES_HOST_CONTENT_ROOT="$$ABS_CONTENT_ROOT" \
	ZENNOTES_CONTAINER_CONTENT_ROOT="$$ABS_CONTENT_ROOT" \
	ZENNOTES_CONTAINER_DEFAULT_VAULT_PATH="$$ABS_CONTENT_ROOT" \
	ZENNOTES_BROWSE_ROOTS="$$ABS_CONTENT_ROOT" \
	ZENNOTES_ALLOWED_ORIGINS="http://localhost:$(PORT),http://127.0.0.1:$(PORT)" \
	ZENNOTES_AUTH_TOKEN="$$AUTH_TOKEN" \
	ZENNOTES_ALLOW_INSECURE_NOAUTH="$(ALLOW_INSECURE_NOAUTH)" \
	ZENNOTES_HOST_DATA="$$ABS_DATA" \
	ZENNOTES_CONTAINER_UID="$$(id -u)" \
	ZENNOTES_CONTAINER_GID="$$(id -g)" \
	$(COMPOSE) pull
	@$(MAKE) --no-print-directory up

nuke:
	@$(COMPOSE) down --rmi all --volumes || true
	@rm -rf apps/web/dist dist/server-binaries $(DATA)

clean:
	rm -rf apps/web/dist dist/server-binaries

# ZenNotes Quick Run Guide

This guide is for people who just cloned the repo and want to run ZenNotes quickly.

It covers:

- the desktop app
- the self-hosted web app
- the easiest Docker path for a home server or remote server

If you want the full repo and architecture details, read [README.md](README.md). This file is the short version.

## Choose the path you want

Use this if:

- you want the desktop app on your own machine: **Desktop**
- you want ZenNotes in a browser on your home server: **Self-hosted with Docker**
- you want to run the browser version from source without Docker: **Self-hosted from source**

## 1. Run the desktop app

### Requirements

- Node.js 22+
- npm

### Steps

```bash
npm ci
npm run dev:desktop
```

Or:

```bash
make desktop
```

What this does:

- installs the monorepo dependencies
- starts the Electron desktop app in development mode

### Build the desktop app

If you want to build it instead of running dev mode:

```bash
npm run build:prod
npm run pack
```

Platform-specific desktop builds:

```bash
npm run dist:mac
npm run dist:win
npm run dist:linux
```

## 2. Run the self-hosted web app with Docker

This is the easiest path for most home-server users.

### Requirements

- Docker
- Docker Compose

### Steps

```bash
make up
```

Then open:

- [http://localhost:7878](http://localhost:7878) if you are on the same machine
- `http://YOUR_SERVER_IP:7878` if you are running ZenNotes on another machine

Important:

- Docker now binds to `127.0.0.1` by default
- on first run, ZenNotes creates a bootstrap auth token at `./data/auth-token`
- the browser asks for that token once, then uses a secure session cookie

If you want to intentionally disable auth for a trusted local setup:

```bash
ALLOW_INSECURE_NOAUTH=1 make up
```

### What gets mounted by default

By default, Docker mounts:

- host `./vault` -> container at the same absolute host path
- host `./data` -> container `/data`

That means:

- your notes live in `./vault`
- ZenNotes server config lives in `./data`
- the server sees your vault as a real host path, not `/workspace`
- Docker is serving your host files, not storing notes inside the container

### Use a different vault folder

If your notes already live somewhere else, mount that folder instead:

```bash
CONTENT_ROOT="$HOME/Library/Mobile Documents/com~apple~CloudDocs" make up
```

Another example:

```bash
CONTENT_ROOT="$HOME/Documents/MyVault" make up
```

Paths with spaces are supported.

### Secure self-hosted defaults

The default Docker setup also:

- runs the container with your local UID/GID
- uses a read-only root filesystem
- drops Linux capabilities
- enables `no-new-privileges`

The intended deployment model is:

- private network
- VPN / Tailscale
- or ZenNotes behind a reverse proxy

Treat direct public exposure as an advanced setup, not the default path.

### Stop the Docker stack

```bash
make down
```

### Rebuild the Docker stack

```bash
make rebuild
```

### View logs

```bash
make logs
```

## 3. Run the self-hosted web app from source

Use this if you do not want Docker and you are okay running both the frontend and backend locally.

### Requirements

- Node.js 22+
- npm
- Go 1.22+

### Steps

Install dependencies:

```bash
npm ci
```

Run both the web client and Go server together:

```bash
make web-stack
```

Or run them separately:

Terminal 1:

```bash
npm run dev:server
```

Terminal 2:

```bash
npm run dev:web
```

Then open the local web URL shown by Vite in your browser.

### Important

In source dev mode, the browser UI and the Go server are separate processes.

That means:

- frontend changes usually only need the web process
- backend changes need the Go server restarted

## 4. Run the self-hosted server without Docker

If you want a built server binary instead of dev mode:

```bash
npm ci
make server-build
./apps/server/bin/zennotes-server
```

Then open:

- [http://localhost:7878](http://localhost:7878)
- or `http://YOUR_SERVER_IP:7878`

The built server embeds the web app, so you do not need to run `dev:web` for this path.

## 5. Choose a vault in the web version

When you first open the browser version, ZenNotes asks you to choose a vault folder.

Important detail:

- in the web version, you are browsing the **server's filesystem**
- not the browser machine's filesystem
- by default, you can only browse configured allowed roots, not the whole machine

So:

- if ZenNotes is running on your home server, the picker shows folders on that server
- if ZenNotes is running in Docker, the picker only sees folders mounted into the container
- if auth is enabled, the browser prompts for the bootstrap token before it can browse or edit

## 6. Common problems

### “I can’t browse to my real notes in Docker”

Docker can only see mounted folders.

Fix:

- mount the folder you want with `CONTENT_ROOT=... make up`

Example:

```bash
CONTENT_ROOT="$HOME/Documents/ObsidianVault" make up
```

If you need broader browsing than the mounted content root, set `ZENNOTES_BROWSE_ROOTS` explicitly or use `ZENNOTES_ALLOW_UNSCOPED_BROWSE=1` only if you understand the security tradeoff.

### “The web app says the picker or vault route is missing”

This usually means:

- the web client is newer than the running Go server

Fix:

- stop the server
- restart it with `npm run dev:server` or `make server-dev`
- reload the page

### “I want to use iCloud Drive”

For Docker:

- you must mount the iCloud folder into the container

Example:

```bash
CONTENT_ROOT="$HOME/Library/Mobile Documents/com~apple~CloudDocs" make up
```

For non-Docker source runs:

- the server can browse any folder the server process has permission to read

### “The web app opens, but I can’t do anything”

Make sure the Go server is running.

For source runs:

- `npm run dev:server`
- if Docker auth is enabled, open `./data/auth-token` and use that token when ZenNotes asks for it
- plus either `npm run dev:web` or `make web-stack`

For Docker:

- `make up`

## 7. Handy commands

### Desktop

```bash
make desktop
```

### Web + server from source

```bash
make web-stack
```

### Self-hosted with Docker

```bash
make up
```

### Logs

```bash
make logs
```

### Stop Docker

```bash
make down
```

### Show all helper commands

```bash
make help
```

## 8. What to use in practice

Recommended defaults:

- just want to try the desktop app locally: `make desktop`
- want ZenNotes on a home server: `make up`
- want to develop the browser version: `make web-stack`

If you are unsure, start with Docker for self-hosting. It is the simplest setup for most users.

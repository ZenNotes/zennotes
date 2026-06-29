# Self-Host with Docker

This guide is for running ZenNotes in a browser against a vault stored on your own machine, home server, or remote server.

It uses the current supported self-hosted model:

- browser frontend
- Go server
- host-mounted vault
- Docker as the main deployment path

## What Docker is doing

Docker is not the owner of your notes.

The intended model is:

- you create a vault directory on the host
- Docker mounts that directory into the ZenNotes container
- the server reads and writes files in that mounted host directory
- the browser app talks to the server

So the vault remains a normal folder on the host filesystem.

## Requirements

You need:

- Docker
- Docker Compose
- a host directory for your vault

## 1. Create a host vault

Example:

```bash
mkdir -p "$HOME/Notes/ZenNotesVault"
```

You can also point ZenNotes at an existing vault instead of a new one.

## 2. Start the self-hosted stack

From the repo root:

```bash
CONTENT_ROOT="$HOME/Notes/ZenNotesVault" make up
```

This starts the self-hosted browser version with Docker.

Important details:

- the host vault is mounted into the container
- ZenNotes serves that host directory instead of storing notes in container-only storage
- Docker is the main supported path for browser/self-hosted use

## 3. Open the app

Open:

- [http://localhost:7878](http://localhost:7878)

## 4. Authenticate

Secure self-hosted mode generates a bootstrap auth token and stores it under:

- `data/auth-token`

Read the token:

```bash
cat data/auth-token
```

Paste that token into the browser when ZenNotes asks for it.

After login, the browser uses a session cookie, so you should not need to keep re-entering the token on refresh.

## 5. Connect the vault

If the server does not already have a vault selected, the empty-state screen will show:

- `Connect to server vault`

Click it and choose the mounted vault directory.

If you started with:

```bash
CONTENT_ROOT="$HOME/Notes/ZenNotesVault" make up
```

then the selected server-side vault path should correspond to that mounted directory.

## 6. Confirm that the host owns the files

Create or edit a note in the browser.

Then inspect the host directory directly:

```bash
find "$HOME/Notes/ZenNotesVault" -maxdepth 3 -type f | sort
```

You should see the note files on the host, not hidden away in a container-only filesystem.

## 7. Stop the stack

```bash
make down
```

## Useful commands

Start:

```bash
CONTENT_ROOT="$HOME/Notes/ZenNotesVault" make up
```

Stop:

```bash
make down
```

Logs:

```bash
make logs
```

Rebuild:

```bash
CONTENT_ROOT="$HOME/Notes/ZenNotesVault" make rebuild
```

## Permissions

If the server exits on startup with a permission error like:

```text
vault init: mkdir /workspace/inbox: permission denied
```

…the container can't write to your mounted vault. ZenNotes runs as a **non-root user** inside the container (UID `65532` in the published image), and Docker bind mounts preserve the host's ownership — so the mounted directory has to be writable by the UID the container runs as. A directory you own as your normal user is *not* writable by UID `65532`, which is why it fails even on folders you "have access to".

**With `make up` / Docker Compose:** this is handled for you. The stack runs the container as your own user (`$(id -u):$(id -g)`) and creates the vault and `data` directories as you, so there's nothing to do.

**Running the image directly with `docker run`:** pass `--user` so the container runs as you, and make sure both mounted directories (the vault and `data`) are owned by that user:

```bash
mkdir -p ./vault ./data

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:7878:7878 \
  -v "$PWD/vault:/workspace" \
  -v "$PWD/data:/data" \
  -e ZENNOTES_AUTH_TOKEN="$(openssl rand -hex 32)" \
  adibhanna/zennotes
```

Alternatively, instead of `--user`, give the image's default UID write access to the host directories:

```bash
sudo chown -R 65532:65532 ./vault ./data
```

Either way works — the only requirement is that the UID the container runs as can write to the mounted host directories.

## Security notes

The current self-hosted model is designed around:

- single-user use first
- private network, reverse proxy, or VPN access
- a host-mounted vault

Important points:

- Docker defaults are intended to be safer than a wide-open dev setup
- the browser app logs in with a bootstrap token and then uses a session cookie
- the server restricts vault browsing based on configured browse roots
- vault notes are written with `0600` and dirs with `0700` by default
- asset uploads default to a 50 MiB cap and note writes to 10 MiB

If you expose ZenNotes beyond your LAN, the recommended model is:

- put it behind a reverse proxy
- terminate TLS there
- treat direct public exposure as unsupported-by-default
- set `ZENNOTES_BEHIND_TLS=1` so cookies get the `Secure` flag and the
  server emits HSTS
- set `ZENNOTES_TRUSTED_PROXIES` (CIDR list) so the server only honours
  `X-Forwarded-*` headers from your reverse proxy

## Useful environment variables

The container reads these on startup. Set them in `docker-compose.yml`
or via the orchestrator of your choice.

- `ZENNOTES_AUTH_TOKEN` — bootstrap token. Required for non-loopback binds.
- `ZENNOTES_AUTH_TOKEN_FILE` — read the token from a file path. Use this
  with Docker/Kubernetes secrets so the value never lives in `.env`.
- `ZENNOTES_BEHIND_TLS=1` — declare that a TLS-terminating proxy is in
  front. Enables `Secure` cookies and `Strict-Transport-Security`.
- `ZENNOTES_TRUSTED_PROXIES` — comma-separated CIDR list. Required if
  the proxy is on a different IP than loopback (e.g. on a Docker bridge
  network or a separate host).
- `ZENNOTES_ALLOWED_ORIGINS` — comma-separated origins permitted to use
  the API from the browser. Misses are logged once per origin.
- `ZENNOTES_BROWSE_ROOTS` — directories the server may consider as
  vault candidates. Anything outside is rejected.
- `ZENNOTES_MAX_NOTE_BYTES` / `ZENNOTES_MAX_ASSET_BYTES` — per-request
  byte caps for `/api/notes/write` and `/api/assets/upload`. Defaults
  10 MiB and 50 MiB.
- `ZENNOTES_VAULT_FILE_MODE` / `ZENNOTES_VAULT_DIR_MODE` — octal mode
  for new files / directories. Defaults `0600` and `0700`.
- `ZENNOTES_BASE_PATH` — mount the API and static bundle under a
  subpath instead of the domain root. Use this when deploying behind a
  reverse proxy that routes by path (e.g. `example.com/zennotes/`).
  See [Reverse-proxy with a path prefix](#reverse-proxy-with-a-path-prefix).
- `ZENNOTES_DISABLE_WATCHER=1` — turn off the inotify file watcher. The
  vault is still fully served; only live updates (auto-refresh when files
  change on disk) stop. Set this where inotify is restricted or unstable —
  notably **unprivileged LXC containers**, where inotify on a bind-mount can
  wedge the process and lock the volume (see Common problems below).

## Reverse-proxy with a path prefix

If you want to host ZenNotes alongside other apps under a single
domain, set `ZENNOTES_BASE_PATH=/zennotes` (any leading-slash path
works). The server then expects every request to start with that
prefix; the bundled web client reads the prefix from a `<meta>` tag
the server injects into the SPA shell, so API + WebSocket calls
target `/zennotes/api/...` and `/zennotes/api/watch`.

Example Nginx fragment that forwards `/zennotes/` to the container:

```nginx
location /zennotes/ {
    proxy_pass         http://127.0.0.1:7878/zennotes/;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Connection        "upgrade";
}
```

Notes:

- Keep the trailing slash on both sides of `proxy_pass` so the prefix
  is preserved, not stripped.
- The path is always rooted (must start with `/`); a trailing slash
  is ignored. `ZENNOTES_BASE_PATH=zennotes/` is treated the same as
  `/zennotes`.
- An empty `ZENNOTES_BASE_PATH` (or `/`) means "serve at root" — the
  default behaviour for plain Docker installs.

For a deeper walkthrough of the security choices and a full env-var
list, see:

- [Secure Self-Hosting](./secure-self-hosting.md)
- [At-Rest Encryption](./at-rest-encryption.md)
- [Security Reference](../reference/security-reference.md)

## Common problems

### The browser opens, but `Connect to server vault` does nothing

In the normal self-hosted path, Docker is the primary way to run browser plus server together.

If you are instead running the web dev server directly, you need both:

```bash
npm run dev:web
npm run dev:server
```

Without the Go server, the browser UI has nothing to call for `/api/*`.

### The vault path looks wrong inside Docker

That usually means you are looking at the wrong path layer.

The important rule is:

- the host path is the source of truth for your files
- the app is serving that mounted directory

If you create a note and the file appears in the host vault, the setup is working as intended.

### The vault directory looks empty, but the app shows notes

Check the vault model. By default, ZenNotes may still place primary notes in `inbox/`.

So your notes may be under:

- `<vault>/inbox/`

not directly in the vault root.

If you want a flatter layout, change:

- `Settings -> Vault -> Primary notes location -> Vault root`

### The container hangs and won't stop (unprivileged LXC)

If the web page loads but the container ignores `docker stop`/`docker kill`
(and even `kill -9`), and the bind-mounted volume on the host is locked, the
culprit is almost always the inotify file watcher on a restricted host —
typically an **unprivileged LXC container**, where inotify on a bind-mounted
directory can put the process into an unkillable state.

Run with the watcher off:

- `ZENNOTES_DISABLE_WATCHER=1`

The vault is still fully served; you only lose live auto-refresh when files
change on disk (reload the page to pick up external edits). On startup the
server now also logs a warning instead of failing silently if it can only
watch part of the vault.

## Related docs

- [Connect Desktop to a Remote ZenNotes Server](./connect-desktop-to-remote-server.md)
- [Vault and Folder Model](../reference/vault-and-folder-model.md)
- [How ZenNotes Works](../explanation/how-zennotes-works.md)

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

## Security notes

The current self-hosted model is designed around:

- single-user use first
- private network, reverse proxy, or VPN access
- a host-mounted vault

Important points:

- Docker defaults are intended to be safer than a wide-open dev setup
- the browser app logs in with a bootstrap token and then uses a session cookie
- the server restricts vault browsing based on configured browse roots

If you expose ZenNotes beyond your LAN, the recommended model is:

- put it behind a reverse proxy
- terminate TLS there
- treat direct public exposure as unsupported-by-default

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

## Related docs

- [Connect Desktop to a Remote ZenNotes Server](./connect-desktop-to-remote-server.md)
- [Vault and Folder Model](../reference/vault-and-folder-model.md)
- [How ZenNotes Works](../explanation/how-zennotes-works.md)

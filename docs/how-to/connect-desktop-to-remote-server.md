# Connect Desktop to a Remote ZenNotes Server

This guide is for using the desktop app against a remote ZenNotes server instead of only a local vault.

This is the model you use when:

- the server is running on another machine
- the server is running in Docker
- you want the desktop app and browser app to point at the same server-backed vault

## What remote mode means

In local mode:

- desktop reads the vault directly from the local filesystem through Electron

In remote mode:

- desktop talks to the ZenNotes server
- the main process handles the network requests
- the renderer still uses the same shared UI

So remote mode is not a different app. It is the same desktop app using a different workspace backend.

## Before you start

You need:

- a running ZenNotes server
- its URL
- its auth token if auth is enabled

If you are self-hosting with Docker locally, the URL is usually:

- `http://127.0.0.1:7878`

## 1. Open the desktop app

Start the installed app or run from source:

```bash
npm run dev:desktop
```

## 2. Connect to the server

Use one of:

- `Settings -> Vault -> Connect to Server...`
- the command palette
- the empty-state remote connection action

Enter:

- the server URL
- the auth token if required

If the token is blank and the server does not require it, the connection should still continue.

## 3. Choose the remote vault

If the server does not already have a vault selected, ZenNotes will open the server-side directory picker.

Choose the vault folder on the server.

Once connected:

- the app should switch to the remote workspace
- the sidebar and title bar should indicate that you are in `Remote` mode

## 4. Save the connection

ZenNotes can keep multiple saved remote workspaces.

You can:

- save a remote connection
- give it an optional label
- edit the URL, token, or vault path later
- remove it

Saved remotes appear in:

- `Settings -> Vault`
- the command palette under vault-related actions

## 5. Change the remote vault path later

While still connected to the same remote server:

- open `Settings -> Vault`
- choose `Change Remote Vault...`

This lets you repoint the current remote connection to a different folder on the same server without going all the way back through the initial connection flow.

## 6. Return to local mode

To disconnect from the remote workspace:

- `Settings -> Vault -> Return to Local Vault`

ZenNotes should switch back cleanly to the local vault workspace instead of leaving stale remote data on screen.

## 7. Know what changes in remote mode

Some behaviors are intentionally different in remote mode.

Examples:

- the app shows a visual `Remote` indicator
- copying an absolute path becomes copying a `Server Path`
- custom templates in `Settings -> Templates` are stored in the remote vault's `.zennotes/templates/` directory and stay live across connected clients
- older servers keep custom-template controls disabled until the server is updated; built-in templates still work
- revealing files in Finder or another local file manager may be unavailable or changed, because the file may only exist on the server host

Desktop-only shell features still exist because you are still using the desktop app:

- native menus
- tabs and panes
- floating windows
- desktop command routing

## Troubleshooting

### I connect successfully, but still see the previous vault

That is the kind of state switch ZenNotes now clears explicitly when changing workspaces.

If it still happens:

- restart the app
- reconnect
- confirm that the sidebar switches immediately without a manual refresh

### I get `fetch failed` or a connection error

Check:

- the server is actually running
- the URL and port are correct
- the token is correct if auth is enabled

Example local server URL:

- `http://127.0.0.1:7878`

### The remote vault profile will not disappear when I remove it

That was previously caused by legacy remote config migration. Current behavior should remove it cleanly, including the last saved remote.

If you remove the last saved remote while connected remotely, ZenNotes should automatically switch back to the local workspace.

## Using the `zn` CLI against the server

The CLI reaches the same server the desktop and web clients do. Every command
except `zn open` works remotely.

Once you have connected the desktop app to a server, that server is nameable
from the terminal — the CLI reads the same saved profiles:

```bash
zn vault list                    # local vaults and servers, together
zn list --server home
zn capture "from my laptop" --server home --tag work
zn task toggle "inbox/Daily.md#0" --server home
```

`--vault <name>` resolves either kind, so a name that belongs to a server
works there too:

```bash
zn list --vault home
```

`--server` wins when both are given, which is what you want in a script if a
local vault and a server happen to share a name. (If they do, `--vault` refuses
to guess and tells you to be explicit.)

### A server you have not saved

Pass the URL directly, with the token if auth is enabled:

```bash
zn list --server 192.168.1.10:7878 --token "$TOKEN"
zn list --server https://notes.example.com --token "$TOKEN"
```

A bare `host:port` gets `http://` filled in.

### CI and headless machines

Set the environment instead of saving anything to disk. This is the case where
a machine has the CLI and nothing else:

```bash
export ZENNOTES_SERVER=notes.example.com:7878
export ZENNOTES_REMOTE_TOKEN="$TOKEN"

zn capture "nightly build failed" --tag ci
```

Token precedence is `--token`, then `ZENNOTES_REMOTE_TOKEN`, then whatever the
saved profile carries.

### What differs from a local vault

- `zn open` hands file paths to the desktop app, so it needs a local vault. Use
  `zn read <path>` to print a remote note instead.
- `zn search` runs the server's search engine (ripgrep where available) rather
  than the CLI's own scan, so ordering can differ. `--limit` is applied by the
  CLI after the server responds.
- `zn create` with a body is two requests (create, then write), because the
  server's create route takes no body.

## Rotating the server's auth token

If you suspect a leaked token, rotate it from any authenticated client:

```bash
curl -X POST https://notes.example.com/api/session/rotate-token \
  -H "Authorization: Bearer $CURRENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"currentToken":"'"$CURRENT_TOKEN"'","newToken":"'"$NEW_TOKEN"'"}'
```

Rotation invalidates all existing sessions, so the desktop will need
to be reconnected with the new token. Update the saved remote profile
under **Settings → Remote workspaces** with the new value.

If the server token is supplied by `ZENNOTES_AUTH_TOKEN` or
`ZENNOTES_AUTH_TOKEN_FILE`, the API rotation request will return
`409 Conflict`. Rotate the env value or token file on the server and
restart ZenNotes instead.

## Related docs

- [Self-Host with Docker](./self-host-with-docker.md)
- [Secure Self-Hosting](./secure-self-hosting.md)
- [Settings Reference](../reference/settings-reference.md)
- [How ZenNotes Works](../explanation/how-zennotes-works.md)

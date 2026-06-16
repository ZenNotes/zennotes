# ZenNotes CLI

Use this skill when working with a user's ZenNotes vault through the `zen` command-line tool.

## First Step

Run `zen vault info --json` before reading or editing notes. Confirm the active vault and note layout:

- `primaryNotesLocation: "inbox"` means inbox notes have paths like `inbox/Note.md`.
- `primaryNotesLocation: "root"` means inbox notes live at the vault root and have paths like `Note.md`.

Always pass paths returned by `zen` back verbatim. Do not prepend `inbox/` or reconstruct paths from titles.

## Read And Search

Use these commands to locate notes:

- `zen list --json`
- `zen list --folder inbox --json`
- `zen search "query" --json`
- `zen search-title "query" --json`
- `zen tag list --json`
- `zen tag find tag --json`
- `zen backlinks <path> --json`

Before changing an existing note, read it:

```sh
zen read "<path>"
```

Use `zen read "<path>" --json` when you need metadata and body together.

## Create And Edit Notes

Prefer narrow edits over full rewrites:

- `zen append "<path>" --body "..."`
- `zen prepend "<path>" --body "..."`
- `printf '%s\n' "text" | zen append "<path>" --body -`
- `zen create --title "Title" --folder inbox --body "..."`
- `zen capture "Quick note" --tag idea`

Use `zen write "<path>" --body ...` only when replacing the full note is explicitly intended. Preserve frontmatter unless the user asked to change it.

## Move, Trash, Archive

Use:

- `zen move "<path>" --folder inbox|quick|archive|trash --subpath "Optional/Subfolder"`
- `zen rename "<path>" --to "New Title"`
- `zen duplicate "<path>"`

`zen trash "<path>"` and `zen archive "<path>"` soft-delete into recoverable stores and print a recovery handle:

```sh
zen trash "inbox/Old.md"
zen restore "trash/<id>"
zen archive "inbox/Done.md"
zen unarchive "archive/<id>"
```

Use the returned handle for restore/unarchive when available.

Hard delete commands are irreversible. Use them only after explicit user confirmation:

- `zen delete "<path>" --yes`
- `zen folder delete "inbox/Folder" --yes`

## Folders

Use:

- `zen folder list --json`
- `zen folder create "inbox/Project"`
- `zen folder rename "inbox/Old" --to "inbox/New"`

Folder command paths start with `inbox`, `quick`, or `archive`.

## Tasks

Use tasks through the CLI instead of manually editing checkbox lines when possible:

- `zen task list --json`
- `zen task list --unchecked --tag work --json`
- `zen task toggle "<sourcePath>#<taskIndex>"`

Task ids come from `zen task list`; do not invent them.

## Assets

Use asset commands instead of editing files under `assets/`, `attachements/`, or `_assets` directly:

- `zen asset list --json`
- `zen asset import "/absolute/file.pdf" --json`
- `zen asset rename "<path>" --to "Name.pdf" --json`
- `zen asset move "<path>" --to "assets/Project" --json`
- `zen asset duplicate "<path>" --json`
- `zen asset trash "<path>" --json`
- `zen asset restore "trash/<id>" --json`
- `zen asset migrate --json`

Managed resources live as `assets/<uuid>.asset/` bundles. Treat the bundle as one asset. Use the returned `path` for asset commands, `sourcePath` only when you need the real file bytes, and embed managed assets as `![[asset:<id>|<name>]]`. Never edit bundle `meta.json`, `source.*`, or `previews/` by hand.

## Safety Rules

- Read before write.
- Use JSON output for automation.
- Quote note paths; they may contain spaces.
- Prefer append/prepend/capture/create over full-file write.
- Do not scan or rewrite an entire vault unless the user explicitly requested it.
- Do not use permanent delete commands without explicit confirmation.

# Vault behavior and self-hosted HTTP fixtures

These JSON cases describe behavior shared by independent implementations. They
contain note bytes, operations, and expected results, with no runtime dependency.
The fixture schema has its own version; product versions do not change it.

`self-hosted-http.json` defines the existing `self-hosted-http-v1` baseline for the
web bridge and TUI remote adapter: capabilities, bearer authentication, browser
session cookies, note fields, exact UTF-8 note bytes, and missing/directory errors.
Go runs it at both `/` and `/notes`. Writes retain the existing last-write-wins
behavior; this is not the revision-based Cloud save protocol. Additive fields are
compatible. Breaking route, authentication, status, or field changes need a new
protocol marker and an explicit consumer migration.

The HTTP baseline exposed two Go gaps corrected during this migration: session
cookies now cover the configured URL prefix, and metadata includes `assetEmbeds`
as required by the bridge contract. Go invalidates old metadata caches so unchanged
notes receive the new field too.

`task-roundtrip.json` covers due-date writes, in-progress state, fenced examples,
preserving unrelated Markdown bytes, and assigning the local calendar day near
midnight. `localNow` is `[year, month, day, hour, minute]`, with a one-based month,
interpreted in the executing host's local timezone. All `expectedAfter` fields
must match; implementations may expose additional metadata.

TypeScript runs these through `shared-domain/src/task-roundtrip.test.ts`. Run the
timezone cases in both directions from UTC:

```sh
TZ=America/Los_Angeles npm run test:run --workspace @zennotes/shared-domain -- task-roundtrip
TZ=Pacific/Auckland npm run test:run --workspace @zennotes/shared-domain -- task-roundtrip
```

The Go server (ZenNotes/znserver) runs the same cases in `internal/vault/task_roundtrip_contract_test.go`.
Its client sends the edited Markdown; the server verifies storage and parsing
before and after that write. The JSON and SHA-256 provenance are vendored in its
`testdata` directory so `go test ./...` needs no Node or sibling checkout.

`mcp-scope.json` is scoped MCP access (ZenNotes/tui#21): what an MCP client
launched with `--allow-path`, `--deny-path`, `--read-only` or `--access` may see
and change. It seeds real vaults (a root-mode vault with a symbolic link to a
hidden folder and one out of the vault, accented folder names, an inbox-mode
vault with remapped system folders), builds a scope from flags, and drives the
MCP server the way a client does: the tools it lists with their annotations,
each call's result or exact error text (`Error: ` plus `error`), and what is on
disk afterwards. `$VAULT` in `contains` / `excludes` is the vault's absolute
path. `flagCases` hold the flag validation, refusals byte for byte. The
desktop's bundled server runs it in `apps/desktop/src/mcp/scope-contract.test.ts`
and the Go `zn mcp` in ZenNotes/tui `internal/mcp/scope_contract_test.go`; the
rules themselves live in `packages/shared-domain/src/mcp-scope.ts`.

Two engine differences are left out of it on purpose. Renaming a note under a
path restriction rewrites `[[links]]` in the notes the client can see in zn,
and in no note at all in the desktop's engine, which never rewrites inbound
links; both leave hidden notes untouched, which is what the fixture checks.
And `list_assets` lists every non-note file in zn but only the attachments
folders in the desktop's engine, so the fixture checks only that hidden assets
stay out.

After changing a fixture, run `npm run sync:contract-fixtures -- <znserver checkout>`
(or set `ZENNOTES_SERVER_DIR`) and `npm run sync:contract-fixtures -- --tui <tui
checkout>` (or set `ZENNOTES_TUI_DIR`), then the TypeScript and Go checks in
every repository; `npm run check:contract-fixtures` with the same arguments
compares without writing. Fixture artifact publication is still pending. Do not
silently rewrite expected results to match a divergent implementation; identify
the intended behavior first.

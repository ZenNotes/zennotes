# Workflows

A visual, keyboard-drivable pipeline editor for the vault.

> **Status (updated for v2.29, August 2026).** This is the design document the
> feature was built from, kept as rationale, not as a manual. If you are here to
> learn how workflows work, the real docs are the in-app Help (`:help`, section
> "Workflows") and https://zennotes.org/docs. What this doc calls "the gallery"
> ships as the **New workflow** button inside the Workflows view: a picker of
> eight built-in recipes, each an ordinary `.md` file that copies into your
> vault.
>
> Shipped in 2.20: manual runs (from the view and the command palette), the
> canvas/text lossless pair, the dry-run confirmation, byte-for-byte Undo with
> crash recovery, presets, import-as-review, and the guided tutorial. Desktop
> local vaults shipped first. Since 2.29, current self-hosted web servers also
> store workflow files and apply the browser-prepared transaction under the Go
> vault lock, with the same journalled Undo and crash recovery. Electron remote
> workspaces remain read-only. Not shipped yet, and described below as design:
> event and schedule triggers (they parse but do not fire), workflow MCP tools,
> and anything labeled community.

## Problem Statement

**How might we** let someone compose ZenNotes' existing actions into a repeatable,
visible, trustworthy automation over their notes, without reopening the plugin
platform that was already built and reverted?

ZenNotes today has three separate action vocabularies and no way for a user to
combine any of them:

| Surface | Location | Size |
| --- | --- | --- |
| Command registry | `packages/app-core/src/lib/commands.ts` | ~200 stable IDs |
| MCP tools | `apps/desktop/src/mcp/server.ts` | 30 headless vault ops |
| `zn` CLI | `apps/desktop/src/cli/` | 8 command groups |

A user who does the same five step dance every morning has no way to name it.
A user who wants "every note tagged #book with rating 4 or higher, in a table in
my reading log" has to maintain it by hand forever.

## Recommended Direction

**Wires carry note sets.** A node is a function `NoteSet -> NoteSet` with optional
side effects. This single decision is the spine of the design, and three
important properties fall directly out of it.

**1. Debugging is free.** Every wire knows its contents, so every wire renders its
count and opens to the list of notes currently on it. The number one reason
visual builders fail (you cannot see why it did that) is solved by the data
model rather than by extra UI. It is also the demo.

```
[ #book ]──47──▶[ rating ≥ 4 ]──12──▶[ sort ]──▶[ table ]──▶[ ▶ Reading Log.md ]
                       └────35──▶[ tag #someday ]
```

**2. Dry run is free.** Sources and filters are reads; only mutate and sink nodes
write. The whole graph can execute in plan mode and produce a real diff before
anything touches disk. This is the answer to "automation over my files is
terrifying."

**3. Auto layout means no coordinates in the file**, which means the graph is
losslessly a text file, which means the canvas and the keyboard editor are the
same artifact at two zoom levels rather than two implementations. It also diffs
cleanly in a git backed vault and syncs like any other vault file.

```
.zennotes/workflows/reading-log.md      frontmatter + a pipeline block
            ↕  lossless, both directions
        the canvas                      a projection, layout computed
```

This is why "elegant node UI" and "fully keyboard drivable" are not in tension
here. They are the same object.

### Why this is differentiated

Every node editor in existence assumes a mouse: n8n, Zapier, Node-RED, Unreal
Blueprints, Blender shader nodes. A node editor you can build end to end with
`hjkl`, that never requires the trackpad, does not exist. For a product whose
identity is keyboard first with vim motions everywhere, that is not a compromise
on the canvas idea. It is the most on brand version of it.

## The Format

Because wires are the primary object, the format **names wires, not nodes.**
Assignment plus pipes. Fan out is just referencing a wire twice.

```markdown
---
name: Reading log
description: Keep the reading log table in sync
trigger: manual
key: <leader>wr
---

books   = tag #book
good    = books | where rating >= 4 | sort finished desc
someday = books | where rating < 4

good    | render table title, rating, finished | write-section "Reading Log.md" "Finished"
someday | add-tag #someday
```

Line oriented, so vim motions work on it natively. Diffable, so a git backed
vault produces readable history. Every named wire is an edge label on the canvas
carrying its live count, which is exactly the symmetry we want given that wires
are what matter.

There is exactly **one construct**: a pipeline. `=` names the wire a pipeline
produces, and a statement without `=` is terminal. An earlier draft had a
separate `->` form for terminal statements; collapsing the two removed a whole
branch of the grammar, the parser, and the canvas, at no cost to readability.

Fan out needs no syntax at all. Two statements reading `books` *is* the branch,
which is why there is no `branch` node in the registry.

## The Node Vocabulary

Roughly 30 nodes. The bottom half of this table is already implemented and
tested as headless MCP operations, which is a substantial head start.

| Kind | Nodes | Reuses |
| --- | --- | --- |
| Sources | all, folder, tag, search, current note, selection, database, changed since | `list_notes`, `search_by_tag`, `search_text` |
| Filters | frontmatter compare, tag, path glob, content match, date window, task open | `FilterRule`, `filterRows` |
| Order | sort, limit, dedupe | `sortRows` |
| Shape | branch, union, subtract, group by | new |
| Mutate | set frontmatter, add/remove tag, move, rename by pattern, append, prepend, apply template, archive, trash, toggle task | `move_note`, `archive_note`, `append_to_note`, `replace_in_note` |
| Render | table, list, board, count, per note template | `database-transforms` |
| Sinks | write note, replace section, create per item, clipboard, notify | `write_note`, `create_note` |
| Compose | call another workflow | new, call graph must stay a DAG |
| Triggers | manual, on event, on schedule | `watcher.ts`, `internal/watcher/watcher.go` |

## The Keyboard Model

Layout is computed, so there is nothing to drag and no positions to maintain.

```
j / k        next / previous node along the chain
h / l        cross to a sibling branch
o / O        insert a node below / above, auto wired
dd           delete node, heal the wire
yy p         duplicate a node
/            jump to a node or wire by name
Enter        edit the focused node's config
gp           preview: list the notes on the focused wire
<leader>wd   dry run, show the diff
<leader>wr   run
u            undo the entire last run
```

Mouse is fully supported and never required. New bindings must be registered in
`packages/shared-domain/src/keymaps-catalog.ts` so they stay overridable from
`config.toml`, and per the project's standing rule, every one of them ships with
a vim binding on day one.

## The Trust Model

Non negotiable, and shipped in the same release as the first mutating node. This
is the part that decides whether the feature survives contact with real vaults.

- **Dry run by default.** Any graph containing a mutating node previews its diff
  before applying. Confirm to apply.
- **Whole run undo.** A run journal records every write with its inverse. One
  keystroke reverses the entire run, not node by node.
- **Run ledger on disk.** Writes performed by a workflow are recorded under
  `.zennotes/workflows/.runs/` as (path, content hash, workflow, timestamp).
  When the executor observes a change it hashes the content; a match against
  something it just wrote means ignore. This lives on disk rather than in memory
  specifically so it survives sync, which is the only way to break a loop that
  crosses machines.
- **Cycle guard, static.** A workflow may call another workflow as a node, so the
  call graph must be a DAG. Cycles are detected at save time and rejected, naming
  the cycle. This is cheap and catches the common case at authoring time.
- **Cycle guard, dynamic.** A workflow writing a file that fires an event that
  runs a workflow is not statically detectable. That case is bounded by the run
  ledger above, a per run node budget, and a max chain depth across workflows.
- **Prefer idempotent sinks.** Replace section is safe to run twice; append is
  not. Where a preset can be expressed either way, it is expressed the replace
  way, so that a double fire is harmless rather than corrupting.
- **Debounce** on save events.
- **Never silent.** Any run that mutated files leaves a visible, dismissable
  record of what changed.

### Collision with unsaved editor changes

Before applying, the engine intersects the set of notes it will write (known
exactly, from the dry run) with the set of open buffers holding unsaved changes.
If that intersection is non empty, the behaviour depends on how the run started,
because a modal that appears while you are typing because a cron fired is worse
than the problem it solves.

- **Manual runs prompt.** A confirmation names the colliding notes and offers:
  save my changes then run, discard my changes and run, skip those notes, or
  cancel the run.
- **Event and schedule runs never prompt.** They skip the colliding notes and
  leave a non blocking notice ("2 notes skipped, unsaved changes") that opens the
  same dialog on click. Nothing modal ever interrupts typing.

### Undo across a partially failed run

A run journal appends the inverse of every write before executing it. If a node
fails midway, the run halts and the offered default is to roll back the entire
run, including the steps that already succeeded. Half applied is worse than not
applied, because the user cannot reason about which half landed.

Some sinks are not invertible (clipboard, notify, external export). Those are
marked as such, excluded from the guarantee, and the dry run states up front that
the run contains N steps that cannot be undone.

## Triggers

- **Manual.** Command palette, vim binding, or right click on a note or a
  multi selection. Always available.
- **Events.** `note created`, `note saved`, `note moved`, `tag added`, each with a
  `where:` scope. Both watchers already exist. The cycle guard above is a
  prerequisite, not a follow up.
- **Schedule.** Cron style. When the desktop app is closed nothing fires, so the
  semantics are catch up on launch: a schedule that came due while the app was
  shut runs at next launch, with a visible prompt rather than silently. For self
  hosters the Go server is the real answer, since it already runs continuously
  and already watches the vault.

### The executor

Background execution is owned by **exactly one executor per vault**, covering both
event triggers and schedules. The executor processes changes regardless of
origin, whether the user typed them locally or they arrived via sync.

- In remote workspace mode the executor is always the Go server.
- In local mode it is a designated device, claimed by the first one to enable
  event triggers. Other devices display "Event triggers run on <device>. Take
  over?" and never fire on their own.
- Mobile is never eligible. iOS background execution is too constrained to be a
  reliable owner. Phones run manual workflows only.

The two naive alternatives both fail, and it is worth recording why. *Fire on
local edits only* means a note created on the phone is never processed, which
reads to the user as the feature being broken. *Every device fires* means one
workflow runs once per device, so a non idempotent sink applies three times, and
one device's write syncs to another and fires it there. In memory origin tagging
cannot fix that second case, because the tag does not survive sync: the receiving
machine has no way to know the change originated from a workflow.

Third party sync (iCloud, Dropbox, Syncthing) delivers partial writes and
conflict artifacts, so the executor debounces and ignores conflicted copies and
placeholder files rather than treating them as ordinary changes.

## Execution and Runtime

In remote workspace mode the graph executes **server side**, in Go. This is the
correct call: it is the only way a scheduled trigger can fire while no client is
open, and it keeps a shared vault's automation consistent no matter which client
touched it last.

It also has a real cost that should be budgeted for explicitly rather than
discovered later. The pipeline semantics (filter operators, sort ordering, date
window arithmetic, tag matching, frontmatter coercion) would then exist twice:
once in TypeScript for local execution, once in Go for the server. This codebase
already has a known problem in exactly this shape, where content parsing rules
are duplicated across several TypeScript copies and a Go copy and have to be kept
in sync by hand.

The mitigation ships with the feature, not after it: **a shared golden fixture
conformance suite.** One directory of `input graph + input vault + expected
output` cases, executed by both the TypeScript engine and the Go engine in CI.
Neither implementation is the source of truth; the fixtures are. Any new node or
operator adds a fixture before it adds an implementation.

Alternatives considered and rejected: bundling a Node runtime alongside the Go
server (breaks the single binary self hosting story), and keeping orchestration
on the client while the server only serves primitives (means scheduled triggers
cannot fire unless a client happens to be open, which defeats the point).

## MCP Surface

Workflows are exposed to agents, alongside the existing 30 vault tools:

| Tool | Behaviour |
| --- | --- |
| `list_workflows` | Names, descriptions, triggers, and whether each mutates |
| `describe_workflow` | The graph, its nodes, and what it would touch |
| `run_workflow` | **Defaults to `dry_run: true`** and returns the diff. Applying requires an explicit `confirm: true` |

The dry run default is the point. An agent can inspect what a workflow would do
and report it back before anything is written, which is the same guarantee the
human gets from the editor, expressed through the same mechanism.

## Serving Both Audiences

The mechanism matters more than the intent. **A preset is not a separate system.**
A preset is an ordinary workflow file. The gallery copies it into
`.zennotes/workflows/`, and it opens in the same editor as anything a user
builds from scratch.

That is what makes the ladder work: run it, peek at it, tweak one filter, build
your own. If presets were hardcoded and workflows were user built, that would be
two features with no path between them, and the median user would never climb.

Ship the gallery as the front door. The editor is the ceiling, not the entrance.

### The gallery is bundled, not fetched

Presets ship inside the app. The deciding argument is not infrastructure cost, it
is that **a preset is executable automation over the user's files.** A bad
community CSS theme makes the app ugly. A bad community workflow moves four
hundred notes into the wrong folder. That is a supply chain risk on a local first
notes app, and it is a categorically higher trust bar than the community theme
gallery, which is still spec only and unbuilt.

Bundling supplies for free what a fetched gallery would have to build separately:

- A preset is a file, so **contributing one is a pull request**, which arrives
  with code review already attached. That is the moderation system.
- It works offline and on first launch. No index to host, no version negotiation,
  no fallback path.
- "Adding a preset requires a release" costs roughly two weeks at this project's
  cadence, which makes it a weak objection here specifically.
- Long tail sharing already works without any infrastructure: paste a file into
  `.zennotes/workflows/`.

Build the seam, not the fetch. The gallery reads from a preset index whose only
source today is bundled, and which could gain a remote source later without
rework.

## Key Assumptions to Validate

- [ ] **People will actually build graphs.** Every tool shipping both a builder and
      presets sees the large majority of users touch only presets. *Test:*
      instrument the Edit button from day one and watch the ratio.
- [ ] **The note set pipeline expresses what people actually want.** It handles
      "find notes, refine, act" beautifully. It does not handle "expand this
      abbreviation" or "push to Notion." *Test:* take 20 real feature requests,
      try to draw each as a graph, count the failures before writing code.
- [ ] **People will trust software to bulk edit their notes.** *Test:* dry run and
      whole run undo must be usable before the first mutating node merges.
- [ ] **Driving a graph by keyboard feels good** rather than like editing a
      spreadsheet blindfolded. *Test:* build linear chains first, dogfood for a
      week before adding branch navigation.
- [ ] **Auto layout stays readable past ~12 nodes.** *Test:* lay out the shipped
      presets first and look at them.

## Scope

Shipping as one release, per the explicit decision to do so rather than stage it.

**In:** the file format and execution engine; the ~30 node vocabulary; the canvas
with computed layout; full keyboard editing; live wire counts and wire
inspection; dry run and whole run undo; manual, event, and schedule triggers with
the cycle guard; the preset gallery; run on desktop and web.

**Out:** see below.

Recommended internal build order, since the release is large: format and engine,
then preset gallery with a read only graph, then the keyboard editor, then the
canvas polish, then triggers. That order keeps a shippable artifact at every
point and surfaces assumption one early even though everything lands together.

## Not Doing (and Why)

- **A code node, or any JS step.** This is the exact door back to `stash@{1}`.
  Every node editor eventually grows one, and retrofitting a "no" is impossible,
  so the "no" has to be now.
- **HTTP and network nodes.** Turns a local first notes app into an integration
  platform, and that is a different product with a different support burden.
- **Shell escape.** Cannot work on iOS or web, and it would mean a synced vault
  carries executable steps. The blast radius is the whole feature's credibility.
- **Authoring on mobile.** A node canvas on a phone is bad at any size. Mobile
  runs and views workflows; it does not edit them.
- **Free node positioning.** Users spend more time untangling spaghetti than
  automating. Computed layout is also what keeps coordinates out of the file and
  the text format lossless.
- **Multi vault workflows.** One vault, one graph.
- **A background daemon.** Schedules catch up on launch, or run on the Go server
  for self hosters. A third always on process is a third product.

## Decisions Made

| Question | Decision |
| --- | --- |
| Note open with unsaved changes | Confirm on manual runs; skip and notify on background runs. Never a modal mid typing. |
| Remote workspace execution | Server side, in Go, with a shared golden fixture conformance suite shipped alongside. |
| Partial failure | Whole run rollback is the default, including the successful prefix. Non invertible sinks are declared up front. |
| Canvas renderer | React Flow. |
| Layout engine | dagre to start, behind a `(nodes, edges) => positions` interface. Reversible in a day; not a design question. |
| MCP exposure | Yes. `run_workflow` defaults to dry run; applying needs explicit confirmation. |
| Sync arriving changes | One designated executor per vault processes all changes regardless of origin. Everyone else stays quiet. |
| Sub workflows | Allowed. Call graph must be a DAG, enforced at save time; dynamic retrigger bounded by the run ledger. |
| Preset gallery | Bundled, not fetched. Contributing a preset is a pull request. The index has a seam for a remote source later. |

## Open Questions

- Does the Go engine or the TypeScript engine own a new node when the two
  disagree during development? The fixtures are the source of truth, but one side
  still has to be written first, and the convention should be decided once.
- How does executor ownership survive the device being lost, wiped, or simply
  never opened again? A stale claim that nobody can release would silently
  disable every background trigger in the vault.
- Does a sub workflow's dry run compose, so that a parent's preview includes
  everything its children would do? It should, and that constrains children to be
  fully plannable without executing.

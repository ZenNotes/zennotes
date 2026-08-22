# Atlas

A map of the vault: every note, every connection, in one navigable place.

> **Status (August 2026).** Design document, nothing shipped. Written as an
> answer to the recurring request for "a graph view like Obsidian's", from a
> position of not wanting Obsidian's graph. An interactive prototype of the
> feel (fake vault, real interactions) sits next to this doc as
> `atlas-prototype.html`; open it in a browser and press `?`.

## Problem Statement

**How might we** let someone see their whole vault at once, follow the
connections between notes, and come away knowing something they did not know
before, without shipping a screensaver?

People keep asking for "the Obsidian thing". What they are actually asking for
is the promise of that feature: my notes are a body of knowledge, show it to
me. The graph view is the most famous answer and it does not keep the promise.
Naming precisely where it fails tells us what to build instead.

## Where Obsidian's graph fails

1. **It is a physics simulation, not a map.** The force layout re-runs every
   time the view opens. Nothing is ever where it was yesterday. Spatial
   memory, the one superpower humans bring to maps ("the cooking stuff lives
   bottom-left"), never gets a chance to form.
2. **Every node is an identical dot.** Which note is a hub, which is abandoned,
   which is a week old: invisible. The screen shows topology and hides all
   semantics.
3. **It answers no questions.** You can stare at it, zoom it, and post a
   screenshot of it. You cannot ask it anything. There is no path from
   "pretty" to "I learned something about my own thinking".
4. **It is mouse-only.** Disqualifying for this app on its own.

At 1,000+ notes these compound into the famous hairball. The antidotes
(filters, groups) are buried in a settings drawer and reset with the layout.

## The idea: cartography, not physics

Atlas treats the vault as territory and draws it the way real maps are drawn:
computed once, updated incrementally, stable for years.

**Pillar 1: a stable map.** The layout is deterministic and cached in the
vault. A new note lands next to its strongest connection; nothing else moves.
Opening Atlas next month shows the same geography as today, grown at the
edges. Reflowing the whole map is an explicit command the user runs on
purpose, never a side effect of opening the view. Stability is the feature;
everything else builds on it.

**Pillar 2: regions with names.** Notes cluster by their link structure and
tag kinship into regions, each drawn as a soft territory with a name derived
from its dominant tag (or hub note), renamable by the user. The vault reads
like a map: Systems Programming up north, Book Notes to the east, the Journal
running along the south.

**Pillar 3: semantic zoom.** Like a real map, altitude controls detail. Zoomed
out: region names and hub notes only, a continent view. Mid zoom: every note,
labels on hubs. Close: every label, every edge. There is no zoom level at
which the screen is a cloud of unlabeled dots.

**Pillar 4: keyboard-first.** Nobody has shipped a graph you can drive without
a mouse. Atlas is fully navigable with vim keys, hint mode included. This is
the part only ZenNotes can build, because the machinery (VimNav, HintOverlay,
which-key) already exists.

**Pillar 5: lenses, and a map that writes back.** The map is an instrument.
Lenses recolor it to answer questions (what is alive, what is orphaned, what
bridges two fields, how did I get from A to B). And when Atlas notices two
notes that should be connected and are not, it shows the ghost of that edge;
accepting it writes a real wikilink into the note. Insight becomes structure.
Obsidian's graph is a poster. Atlas closes the loop.

## Vocabulary (ships on the surface)

| Word       | Meaning                                                      |
| ---------- | ------------------------------------------------------------ |
| **Atlas**  | The view itself. `Space g`, `:atlas`, a Home tile.           |
| **Region** | A named cluster territory. Renamable, stable.                |
| **Lens**   | An overlay that recolors the map to answer one question.     |
| **Orbit**  | The local view: one note centered, its connections in rings. |
| **Replay** | The time lens: watch the vault grow along a date scrubber.   |

Per house rule, every one of these words appears in the UI, not just in docs.

## What the repo already has

This design adds no new parsing and no new synced copy of anything. The
extraction layer exists in app-core and is already the renderer-side sibling
of the synced-copies family:

- `lib/wikilinks.ts`: `extractWikilinkTargets`, `resolveWikilinkTarget`,
  `extractMarkdownLinkHrefs`, `extractMentionSnippet` (unlinked mentions!),
  all behind `stripCodeContent`. ConnectionsPanel already computes backlinks,
  mentions, and missing links for one note; Atlas is that computation for all
  notes at once, cached.
- `lib/tags.ts`: tag extraction with counts, frontmatter included.
- VimNav + HintOverlay + which-key: the entire keyboard model is assembled
  from parts that exist. `Space g` is unclaimed (taken today: o a f s t e p v
  l q i d w m c).
- NoteHoverPreview: hover/focus previews come free.
- The sidebar virtualization lesson: thousands of DOM nodes are a mistake we
  already made once. Atlas renders to a single canvas from day one.
- The perf harness (`perf:desktop-runtime`, 5,000-note vault) is the natural
  home for Atlas budgets.

Because Atlas lives entirely in app-core and reads through the existing
extractors, it ships on desktop and web in the same change, and the Go server
is not involved.

## Design

### The index

A vault-wide connection index, built in a web worker, updated incrementally on
note save/rename/delete events the store already emits:

- **Link edges**: resolved wikilinks and internal markdown links. Directed,
  weighted by occurrence count. These are the only edges drawn by default.
- **Kinship edges**: shared tags (weight by rarity: two notes sharing a
  20-note tag are closer kin than two sharing a 400-note tag). Used by layout
  and suggestions, not drawn.
- **Mention edges**: unlinked title mentions, via the existing extractor.
  Drawn only as ghosts in the Suggestions lens.

Cold build for 5,000 notes is a read of bodies the store mostly already has,
plus regexes we already run per-note elsewhere; the budget below keeps us
honest.

### Layout and persistence

- Clustering: label propagation over link + kinship edges, deterministic tie
  breaks, majority tag naming with hub-title fallback.
- Placement: regions on a golden-angle spiral (big regions claim space first),
  notes within a region by phyllotaxis, refined by a short, seeded, damped
  relaxation. Then **frozen**.
- Incremental: a new note is placed at the weighted centroid of its neighbors
  with deterministic jitter; an unconnected note parks at its folder-mates'
  region edge until it earns links. Existing positions never shift.
- Persistence: `.zennotes/atlas.json` in the vault. Positions, region names,
  user renames. Small, derived, safe to delete (deleting = voluntary reflow).
  In-vault so desktop, web, and any future device share one geography.
- `Atlas: reflow map` is a command with a confirm, and the old file is kept as
  a one-step undo.

### Rendering

One canvas layer, no per-note DOM. Nodes and relationships, kept deliberately
plain: node radius by degree, hue by region, soft nebula glow per cluster,
small-caps serif region names. Labels appear by zoom band (regions, then
hubs, then everything). Edges are quiet by default (a three-state toggle:
quiet, all, off), brightening when an endpoint is hovered or focused. The
focused note carries a gold ring; hover shows the existing NoteHoverPreview.

The prototype renders this map in **both dimensions behind one toggle** (`v`):
the **sky** (3D) puts regions as constellations on a flattened sphere with a
perspective camera that orbits and tilts (hand-rolled projection, still one
canvas, no libraries), depth fog, parallax stars, and a gentle idle drift;
the **map** (2D) is the flat cartographic layout. Both layouts are computed
once from the same seed and frozen, and toggling morphs every note between
its two homes while the camera swings level, so the two views feel like one
place seen two ways. In the map, hjkl and drag pan; in the sky they orbit
and tilt. Everything else (lenses, rings, trace, replay, hints, filter) is
identical in both.

An isometric-city rendering (notes as blocks on district platforms) was
prototyped at length and rejected: even at its most restrained it pulled
attention to the buildings instead of the relationships. The node form stays.
What survives from that detour: links stay quiet until asked for, and the
detail on screen at once is a budget, not an accident.

### Keyboard model (vim ON)

| Keys                 | Action                                                       |
| -------------------- | ------------------------------------------------------------ |
| `Space g` / `:atlas` | Open Atlas                                                   |
| `h j k l`            | Pan                                                          |
| `+` / `-`            | Zoom in / out (semantic zoom bands)                          |
| `f`                  | Hint mode: two-letter labels on visible notes, type to focus |
| `/`                  | Filter: dims every note not matching title/tag, live         |
| `Enter`              | Open the focused note in the editor                          |
| `o`                  | Orbit the focused note                                       |
| `zz`                 | Center on the focused note                                   |
| `[` / `]`            | Previous / next region                                       |
| `1..5`               | Lenses: Structure, Heat, Orphans, Bridges, Suggestions       |
| `t`                  | Replay (time scrubber; `Space` plays/pauses)                 |
| `m` twice            | Trace: mark two notes, shortest link paths light up          |
| `?` / `Esc`          | Help / unwind (lens, filter, orbit, then leave)              |

With vim OFF, per house rule: arrows pan, Enter opens, Escape unwinds, and
every single-key shortcut above is disabled; the toolbar and mouse carry the
full feature set (wheel zoom, drag pan, click focus, lens buttons).

### Lenses

- **Heat**: recency of `updated` as glow. The living edge of the vault in one
  glance; six months of neglect reads as a dark continent.
- **Orphans**: notes with no links in or out. The to-connect (or to-archive)
  pile, spatially grouped by kinship so it is actionable.
- **Bridges**: approximate betweenness; notes that connect regions glow.
  These are reliably the most interesting notes a vault owner owns and no
  other tool surfaces them.
- **Suggestions**: ghost edges from kinship + unlinked mentions, ranked.
  Focus a ghost, `Enter` accepts: a `[[wikilink]]` is appended under a
  `## Related` heading through the normal note-write path (undoable, atomic,
  nothing bespoke). The ghost becomes a real edge on screen.
- **Trace**: mark two notes, see the shortest link paths between them. "How
  does my Rust reading connect to my cooking notes" has an actual answer.
- **Replay**: scrub the vault through time by `created` date, watch regions
  be born. Also, frankly, the demo clip for the release.

### Orbit

`o` on any note animates the map away and lays the note's neighborhood in
rings: direct links (ring 1), two hops (ring 2), unlinked mentions as ghosts.
`Esc` animates back to the exact map you left. Orbit is the "local graph"
people ask for, but ranked and readable instead of a star of dots.

## Performance budgets

Wired into `perf:desktop-runtime` (5,000-note vault), enforced under
`ZEN_PERF_ENFORCE=1`:

- Cold index + layout build: under 2s, in the worker, UI never blocks.
- Incremental update on note save: under 16ms applied.
- Steady-state render: 60fps pan/zoom at 5,000 notes, one canvas.
- Atlas code is lazy-loaded (`LazyAtlasView` like Excalidraw/Workflows) and
  adds nothing to boot. No named manualChunks rule, per the packaging scars.

## Phasing

- **Phase 1, the map.** Index worker, deterministic layout + `atlas.json`,
  canvas renderer, regions, semantic zoom, hint-mode focus, `/` filter,
  open/preview, `Space g`. Ships alone; already better than the thing people
  ask for.
- **Phase 2, the instrument.** Lenses (Heat, Orphans, Bridges, Trace), Orbit,
  Suggestions with write-back.
- **Phase 3, time and show.** Replay, PNG/SVG export of the current map view
  (people share these; let them be beautiful), perf gates, docs in both
  surfaces (help.ts + website).

## Non-goals

- No VR, no physics toy mode. The absence of a physics simulation is a
  feature of this design, not a savings. (An earlier draft ruled out 3D too;
  the maintainer asked for a 3D pass and the prototype now has one. Whether
  the shipped view is 2D, 3D, or a toggle is an open question below.)
- No query language. Live Queries (see `live-queries.md`) is the text answer;
  Atlas is the spatial one. They can feed each other later (a lens defined by
  a query is an obvious Phase 4), but neither waits for the other.
- No folder-hierarchy view. Folders already have the sidebar; Atlas draws the
  link structure folders cannot show.
- Nothing here touches the Go server or adds a fourth synced parser copy.

## Open questions

- The prototype now ships the sky and the map behind one toggle; the open
  question is which is the **default**. 3D is the more evocative first
  impression and depth separates clusters; 2D is likely stronger for spatial
  memory (positions on a plane are easier to remember than in a volume). A
  reasonable answer: open in the map, keep the sky one keypress away, and
  remember the user's choice in the portable prefs.

- Region naming quality on tag-poor vaults (fallback ladder: dominant tag,
  hub title, top folder name; needs testing on a real messy vault).
- Whether kinship edges should influence layout by default or only when link
  density is too low to cluster on (sparse-vault cold start).
- `atlas.json` merge behavior under sync conflict (positions are derived, so
  last-writer-wins is probably fine; region renames are the part worth a
  keep-both prompt).

# Public share viewer

This is the maintained read-only renderer embedded by Laravel's public share
pages. Its source was recovered from `c534a1d0`, then updated for current core APIs,
shared styles, published themes, and graceful fallback. The recovered historical
build was not byte-identical to the previously copied website bundle; see the
ecosystem plan's provenance record. This is a new, independently verified build.

## Build and package

```sh
npm ci
npm run build --workspace @zennotes/share-viewer
npm run pack:share-viewer
```

The producer emits an immutable archive and JSON manifest in
`dist/viewer-artifacts`. The manifest records the `share-page-payload-v1` protocol,
source commit/dirty state, lockfile hash, toolchain, entrypoints, and every asset's
size and checksum. Changing any payload bytes creates a new version; reusing a
version with different bytes fails. This viewer is separate from the self-hosted
web application's login/editor artifact.

`share-viewer.js` and `share-viewer.css` have stable names inside a versioned asset
directory. Chunks/fonts are relative to that directory. Laravel pins the manifest,
verifies and imports the archive without a frontend source checkout, and retains
previous versions for rollback. Candidate CI builds artifacts; it does not publish
or deploy them. Clean-source release publication and Laravel's production build
configuration remain approval gates.

## Payload and fallback

Laravel owns `#zen-share-data`: title, exact Markdown, public asset URL mapping,
pre-rendered TikZ SVG mapping, appearance, and timestamps. Assets are resolved only
from that mapping; TikZ SVGs are sanitized. Private links and task mutations stay
inert. Copy, external links, Mermaid, sanitized TikZ, and Markdown formatting remain.
JSXGraph and function-plot renderers are excluded from this public bundle because
their configuration can introduce executable expressions or unsanitized HTML.
Those fences retain source access and explain that rendering is unavailable.

The page supplies escaped Markdown in `.zen-share-fallback` under
`#zen-share-root`. It remains visible until the renderer completes. Invalid JSON,
missing JavaScript, or module load errors leave the fallback available. The viewer
preserves publication/note themes and follows the OS when appearance is `system`.

The Laravel repository owns browser integration tests using actual generated
share/publication HTML and attachment responses. Run those tests before updating
its deployment pin; a successful standalone Vite build is insufficient.

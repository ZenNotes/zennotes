# The ZenNotes Markdown Pipeline

This document explains how ZenNotes turns a markdown source string into rendered HTML. Read this before writing a remark plugin or debugging rendering behaviour.

---

## Overview

ZenNotes uses the [unified](https://unifiedjs.com/) ecosystem — a family of composable text-processing tools. The renderer does not use markdown-it. The pipeline is:

```
source string
  → remark parsers     (text → AST)
  → remark transformers (AST → AST)
  → remark-rehype       (remark AST → hast)
  → rehype transformers (hast → hast)
  → rehype-stringify    (hast → HTML string)
  → DOMPurify           (sanitize)
  → rendered HTML
```

The pipeline is defined in `packages/app-core/src/lib/markdown.ts` as a single `unified()` processor that is created once and reused across renders. A small LRU cache (24 entries) avoids re-rendering unchanged content.

---

## The two AST stages

### remark AST (mdast)

The remark stage produces an [mdast](https://github.com/syntax-tree/mdast) tree — a markdown-specific abstract syntax tree. Node types include `paragraph`, `heading`, `code`, `blockquote`, `containerDirective`, and so on.

remark plugins receive and transform this tree. They run before the content is converted to HTML, which means they have full knowledge of the markdown structure.

### hast (HTML AST)

`remark-rehype` converts the mdast tree to a [hast](https://github.com/syntax-tree/hast) tree — a generic HTML tree. From this point forward, plugins work with HTML-like nodes (`element`, `text`, `raw`).

rehype plugins run after conversion. They are appropriate for HTML-level concerns: syntax highlighting, math rendering, diagram placeholder insertion.

---

## Plugin registration order

The current pipeline in `markdown.ts`, in registration order:

| Step | Plugin | Purpose |
|------|--------|---------|
| 1 | `remarkParse` | Parse markdown source to mdast |
| 2 | `remarkFrontmatter` | Parse YAML/TOML frontmatter |
| 3 | `remarkGfm` | GitHub Flavored Markdown (tables, strikethrough, task lists) |
| 4 | `remarkBreaks` | Soft line breaks → `<br>` |
| 5 | `remarkMath` | `$...$` and `$$...$$` math |
| 6 | `remarkDirective` | Parse `:::name{attrs}` fences into `containerDirective` nodes |
| 7 | `remarkBoxes` | Transform container directives into styled div/aside elements |
| 8 | `remarkScholarly` | Transform `[[br]]`, `[[indent]]`, `⟪⟫`, bare Devanagari |
| 9 | `remarkWikilinks` | `[[Note]]` → link nodes with `data-wikilink` |
| 10 | `remarkHashtags` | `#tag` → styled links |
| 11 | `remarkCallouts` | Obsidian `> [!type]` callouts |
| 12 | `remarkRehype` | Convert mdast → hast (`allowDangerousHtml: true`) |
| 13 | `rehypeRaw` | Parse raw HTML nodes produced by earlier remark steps |
| 14 | `rehypeMermaid` | ` ```mermaid ` → placeholder div |
| 15 | `rehypeMathDiagrams` | tikz / jsxgraph / function-plot → placeholder divs |
| 16 | `rehypeHighlight` | Syntax highlighting via highlight.js |
| 17 | `rehypeKatex` | Render KaTeX math |
| 18 | `rehypeStringify` | hast → HTML string |
| 19 | DOMPurify | Sanitize the HTML string |

**Order matters.** `remarkDirective` must run before `remarkBoxes`. `rehypeRaw` must run after `remarkRehype` so that raw HTML fragments injected by remark plugins are parsed correctly.

---

## The hName/hProperties bridge

remark and rehype share a convention for passing HTML rendering hints through the mdast tree. Any mdast node can carry a `data.hName` and `data.hProperties` field:

```ts
node.data = {
  hName: 'aside',
  hProperties: {
    className: ['callout'],
    'data-callout': 'note'
  }
}
```

When `remarkRehype` encounters this node, it produces the corresponding hast element instead of the default one. This is the correct way to produce arbitrary HTML from a remark plugin — it keeps the pipeline's HTML-generation responsibility in the rehype stage where DOMPurify can see it.

`remarkBoxes` uses this bridge. `remarkCallouts` (built-in) uses the same pattern.

---

## HTML injection via `allowDangerousHtml`

`remarkRehype` is configured with `allowDangerousHtml: true`, and `rehypeRaw` runs immediately after. This allows raw HTML nodes in the mdast to pass through to the final output.

DOMPurify sanitizes the final HTML string after `rehypeStringify`. This means that raw HTML fragments are allowed in the pipeline but still sanitized before reaching the DOM.

If you write a plugin that injects HTML, prefer the `hName`/`hProperties` bridge over raw HTML nodes. Raw HTML works but bypasses the structured hast stage.

---

## Sanitization boundaries

DOMPurify runs with:

- `ALLOW_DATA_ATTR: true` — `data-*` attributes are allowed
- `ALLOW_ARIA_ATTR: true` — ARIA attributes are allowed
- An allowlist of specific `data-*` attributes for internal use (`data-wikilink`, `data-callout`, etc.)
- A URI allowlist: `https?`, `mailto`, `zen`, `zen-asset`, `blob`, `data`

Plugins that produce new `data-*` attributes must add them to `ALLOWED_RENDERED_DATA_ATTRS` in `markdown.ts` or they will be stripped by DOMPurify.

---

## Caching

The processor uses a simple LRU map (24 entries, keyed by source string). If the same source string is rendered twice, the second call returns the cached HTML without re-running the pipeline.

This means remark and rehype plugins must be **pure** — given the same input tree, they must produce the same output. Plugins must not read from external state that changes between renders.

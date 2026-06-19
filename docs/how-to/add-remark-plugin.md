# Add a Remark Plugin to the Markdown Renderer

This guide shows you how to add a new remark plugin to the ZenNotes markdown pipeline. It assumes you are familiar with TypeScript and the basics of the unified ecosystem. For architecture background, read [The ZenNotes Markdown Pipeline](../explanation/markdown-pipeline.md) first.

---

## When to write a remark plugin

Write a remark plugin when you want to:

- Add a new block or inline syntax (new container type, new inline marker)
- Transform existing AST nodes into a different structure before HTML is produced
- Add new `data-*` attributes to rendered elements for the runtime to pick up

Write a rehype plugin instead when you need to:

- Post-process the HTML structure after conversion (syntax highlighting, diagram placeholders)
- Inspect or modify HTML attributes that only make sense at the HTML level

---

## The three built-in plugin types

The existing plugins in `markdown.ts` follow three patterns. Match the pattern that fits your use case.

### Pattern 1: Container directive (block)

For `:::name{attrs}` block syntax. Requires `remark-directive` which is already installed.

The plugin visits `containerDirective` nodes produced by `remark-directive` and transforms them into styled elements using the `hName`/`hProperties` bridge.

See `packages/app-core/src/lib/remark-boxes.ts` as a complete example.

### Pattern 2: Inline text transform

For inline markers like `:br`, `:indent`, or `⟪text⟫`. The plugin visits `textDirective` or `text` nodes and splits them into replacement nodes.

See `packages/app-core/src/lib/remark-scholarly.ts` as a complete example.

### Pattern 3: Block node transform

For transforming existing block nodes (blockquotes, headings, code fences). The plugin visits the target node type and rewrites its `data.hName`/`data.hProperties`.

See the `remarkCallouts` function inside `markdown.ts` as an example.

---

## Step-by-step: adding a new container type

This example adds a `:::sidenote` container.

### 1. Define the container name

Open `packages/app-core/src/lib/remark-boxes.ts` and add your container name to `CONTAINER_KINDS`:

```ts
const CONTAINER_KINDS: Record<string, string> = {
  // ... existing entries ...
  'sidenote': 'sidenote',
}
```

### 2. Add the CSS

Open `src/shared/customBoxes.css` and add styles for the new class:

```css
.md-box--sidenote .md-box__inner {
  border-left: 3px solid #0ea5e9;
  background: #f0f9ff;
  font-size: 0.9em;
}
.dark .md-box--sidenote .md-box__inner {
  background: #082f49;
  border-left-color: #38bdf8;
}
```

### 3. Register in the cheat sheet

Open `packages/app-core/src/lib/syntax-cheatsheet.ts` and add an entry to the `cnt` (containers) category:

```ts
{
  label: '::: sidenote',
  before: '\n:::sidenote\n',
  after: '\n:::',
  desc: {
    de: 'Seitennotiz',
    en: 'Side note',
    it: 'Nota laterale',
    fr: 'Note de côté'
  },
},
```

### 4. Done

No changes to `markdown.ts` are needed — `remark-boxes.ts` already handles any name in `CONTAINER_KINDS`. Verify with:

```bash
npx tsc --noEmit -p packages/app-core/tsconfig.json
```

---

## Step-by-step: adding a new inline extension

This example adds `:date` which renders the current date.

### 1. Edit remark-scholarly.ts

Add your directive to the handled cases in `remark-directive-filter.ts` so it isn't reverted to text:

```ts
const SCHOLARLY_DIRECTIVES = new Set(['br', 'indent', 'date'])
```

Add a handler in `remark-scholarly.ts` inside `processDirectives`:

```ts
if (node.name === 'date') {
  const today = new Date().toISOString().slice(0, 10)
  parent.children.splice(index, 1, { type: 'text', value: today } as any)
  return index + 1
}
```

Note: because the pipeline result is cached by source string, `:date` will not update until the note source changes. If you need a live clock, that belongs in a React component that re-renders on a timer, not in the markdown pipeline.

---

## Step-by-step: writing a plugin from scratch

If neither pattern fits, write a standalone plugin file.

### Minimal remark plugin

```ts
// packages/app-core/src/lib/remark-myfeature.ts
import { visit } from 'unist-util-visit'
import type { Root } from 'mdast'

export default function remarkMyFeature(): (tree: Root) => void {
  return (tree: Root): void => {
    visit(tree, 'paragraph', (node, index, parent) => {
      // inspect or transform the node
    })
  }
}
```

### Register in markdown.ts

```ts
import remarkMyFeature from './remark-myfeature'

const processor = unified()
  // ... existing plugins ...
  .use(remarkDirective)
  .use(remarkBoxes)
  .use(remarkScholarly)
  .use(remarkMyFeature)   // add here
  .use(remarkWikilinks)
  // ...
```

Position matters — see the [pipeline order table](../explanation/markdown-pipeline.md#plugin-registration-order) for where to insert.

### If your plugin produces new data-* attributes

Add them to `ALLOWED_RENDERED_DATA_ATTRS` in `markdown.ts`, otherwise DOMPurify strips them:

```ts
const ALLOWED_RENDERED_DATA_ATTRS = [
  // ... existing entries ...
  'data-myfeature-source',
]
```

---

## Testing

The pipeline has no dedicated test harness for plugins, but you can test in isolation with `tsx`:

```bash
# from packages/app-core/
npx tsx src/test-payer-plugins.ts
```

Or write a standalone script following the same pattern and run it with `tsx`.

For type checking:

```bash
npx tsc --noEmit -p packages/app-core/tsconfig.json
```

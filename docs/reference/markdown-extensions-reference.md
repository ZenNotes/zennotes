# Markdown Extensions Reference

ZenNotes renders standard [CommonMark](https://commonmark.org/) plus GitHub Flavored Markdown (GFM). On top of that, the renderer supports a set of extensions for richer note structure. This document describes all non-standard syntax.

This is a reference document — it describes what the syntax does, not why or when to use it. See [Use Container Blocks in Your Notes](../how-to/use-container-blocks.md) for task-oriented guidance.

---

## Container blocks

Container blocks wrap markdown content in a styled `<div>` or `<aside>`. They use the directive fence syntax:

```
:::name{key="value"}
content
:::
```

The fence markers (`:::`) must have no leading spaces. The name must immediately follow the colons with no space.

### Optional title

Any container can have a title via the `title` attribute:

```
:::grammarbox{title="The Dual Number"}
Sanskrit has three numbers: singular, dual, and plural.
:::
```

The title renders above the body as a bold header inside the box.

### Nesting

Containers can be nested by using more colons for the outer fence:

```
::::center
:::grammarbox
Inner content
:::
::::
```

---

## Container types

### `grammarbox`

Yellow left border. Use for grammar rules, paradigm tables, and formal definitions.

```
:::grammarbox{title="Present Tense Endings"}
| Person | Singular | Plural |
|--------|----------|--------|
| 1st    | -āmi     | -āmas  |
| 2nd    | -asi     | -atha  |
| 3rd    | -ati     | -anti  |
:::
```

### `grammarbox2`

Orange left border, bold text. Use for summaries or second-level grammar structures.

```
:::grammarbox2
The strong stem is used before light endings.
:::
```

### `important`

Violet left border. Renders as `<aside>` instead of `<div>`. Use for warnings, critical points, and things students must not miss.

```
:::important
Sandhi rules apply across word boundaries in continuous text.
:::
```

### `note-box`

Gray left border, subdued background. Use for optional side notes, clarifications, and historical remarks.

```
:::note-box
This rule has several exceptions not covered here.
:::
```

### `indent`

Indented block without a border. Use for quoted text, subordinate content, or visual hierarchy without a box.

```
:::indent
A verse from the Rigveda.
:::
```

### `center`

Horizontally centered content. Use for titles, headings within a note, and display formulas.

```
:::center
**Chapter 3 — The Verb**
:::
```

### `media`

Flex column, centered. Use to wrap images together with their captions.

```
:::media
![Devanagari script](./images/devanagari.png)
The Devanagari script, as used for Sanskrit.
:::
```

### `deleteme-box`

Invisible (`display: none`). Use to hide draft passages or review comments that should not appear in the rendered output but should remain in the source file.

```
:::deleteme-box
TODO: verify this declension table
:::
```

### `no-header`

Hides the `<thead>` of any table inside the container. Use when a table's first row should be treated as data, not as a column header.

```
:::no-header
| a  | ā  |
| i  | ī  |
| u  | ū  |
:::
```

### `compact`

Reduces table cell padding. Use for dense reference tables where vertical space matters.

```
:::compact
| Rule | Condition | Result |
|------|-----------|--------|
| 1a   | a + a     | ā      |
| 1b   | a + ā     | ā      |
:::
```

### `laut-table`

Phonetics table style: the first column is wide, non-wrapping, and bold. Use for sound charts, phoneme tables, and place-of-articulation grids.

```
:::laut-table
| Velar    | k  | kh | g  | gh | ṅ |
| Palatal  | c  | ch | j  | jh | ñ |
:::
```

### `metrik-schema`

Monospace, letter-spaced font. Use for metrical patterns using symbols like `–` (heavy) and `◡` (light).

```
:::metrik-schema
◡ – ◡ – ◡ – ◡ –
◡ – ◡ – ◡ – ◡ –
:::
```

---

## Inline extensions

Inline extensions transform special markers inside regular text.

### `:br` — hard line break

Inserts a `<br>` element. Unlike a blank line (which starts a new paragraph), `:br` breaks the line within a single block — including inside table cells, where blank lines are not possible.

```
:::laut-table
| Velar | k:br voiced: g |
:::
```

### `:indent` — inline indent

Inserts a fixed-width invisible span (`1.5em`). Use to align text in columns that are not tables, or to add indentation within a paragraph.

```
Rule 1::indent applies when the stem ends in a vowel.
Rule 2::indent applies when the stem ends in a consonant.
```

### `⟪text⟫` — explicit Sanskrit markup

Wraps text in a `.sanskrit-dev` span (red, slightly larger). Use when you want to mark Devanagari or transliterated Sanskrit explicitly.

```
The word ⟪धर्म⟫ means duty or cosmic order.
```

---

## Standard extensions

These extensions ship with ZenNotes independently of the scholarly extensions described above.

| Extension | Syntax | Notes |
|-----------|--------|-------|
| GFM tables | `\| A \| B \|` | Standard GitHub table syntax |
| GFM strikethrough | `~~text~~` | |
| GFM task lists | `- [x] done` | |
| Math (KaTeX) | `$inline$` / `$$block$$` | |
| Mermaid diagrams | ` ```mermaid ` | |
| Wikilinks | `[[Note Name]]` | Opens linked note |
| Hashtags | `#tag` | Links to tag view |
| Callouts | `> [!note] Title` | Obsidian-compatible |
| Frontmatter | `---` YAML / TOML block | Parsed but not rendered |

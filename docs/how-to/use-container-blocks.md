# Use Container Blocks in Your Notes

Container blocks let you wrap sections of your notes in styled boxes. This guide shows the most common patterns. For the full syntax specification see the [Markdown Extensions Reference](../reference/markdown-extensions-reference.md).

## Write a basic grammar box

Use `:::grammar-box` for grammar rules, paradigm tables, or formal definitions. Add a `title` attribute to label the box:

```
:::grammar-box{title="The -a Stem (Masculine)"}
Nominative singular adds **-as**: *devas* (god)
Accusative singular adds **-am**: *devam*
:::
```

The title appears as a bold header above the box content.

## Highlight an important point

Use `:::important` for anything a reader must not miss — warnings, critical rules, common mistakes:

```
:::important
Sandhi rules apply at every word boundary in continuous Sanskrit text.
Failing to apply them is a grammatical error, not a style choice.
:::
```

This renders as an `<aside>` element with a violet left border.

## Add a side note

Use `:::note-box` for optional context, historical remarks, or clarifications that interrupt the main flow:

```
:::note-box
The grammarian Pāṇini described this rule in the Ashtadhyayi (circa 4th century BCE).
:::
```

## Build a phonetics table

Use `:::laut-table` to format a place-of-articulation table. The first column gets bold, non-wrapping treatment:

```
:::laut-table
| Velar    | k  | kh | g  | gh | ṅ |
| Palatal  | c  | ch | j  | jh | ñ |
| Retroflex | ṭ | ṭh | ḍ  | ḍh | ṇ |
| Dental   | t  | th | d  | dh | n |
| Labial   | p  | ph | b  | bh | m |
:::
```

## Line breaks inside table cells

Standard markdown does not allow line breaks inside a table cell. Use `[[br]]` instead:

```
| Stem | Nominative Singular |
|------|---------------------|
| deva- | devas[[br]]*(god)* |
```

## Write a metrical pattern

Use `:::metrik-schema` for metrical notation. The content renders in monospace with letter spacing:

```
:::metrik-schema
◡ – – | ◡ – – | ◡ –
◡ – – | ◡ – – | ◡ –
:::
```

## Mark Sanskrit text

Devanagari script is detected automatically and rendered in red:

```
The term धर्म (dharma) means cosmic order.
```

To mark IAST transliteration or any other text with the same style, use explicit `⟪⟫` wrappers:

```
The term ⟪dharma⟫ (धर्म) means cosmic order.
```

## Center a heading or verse

```
:::center
**Part II — Nominal Declension**
:::
```

## Nest containers

Use more colons for the outer fence:

```
::::center
:::grammar-box{title="The Seven Cases"}
Nominative, Accusative, Instrumental, Dative,
Ablative, Genitive, Locative — and the Vocative.
:::
::::
```

## Hide draft content from the preview

`:::deleteme-box` renders as invisible. The source stays in the file; the preview hides it:

```
:::deleteme-box
TODO: cross-check this table against Kale §142
:::
```

## Remove a table header

When a table's first row should be data — not column labels — wrap it in `:::no-header`:

```
:::no-header
| a  | ā  | i  | ī  |
| u  | ū  | e  | ai |
:::
```

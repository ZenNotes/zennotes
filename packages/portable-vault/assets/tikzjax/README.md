# Vendored TikZJax (TikZ rendered on the device)

- `tikzjax.js`: single-file browser TikZJax, the WebAssembly TeX engine and
  its precompiled core dump (TikZ, pgfplots, circuitikz, and more) inlined.
- `fonts.css`: the plugin's `styles.css`, the inlined fonts SVG text uses.

Source: https://github.com/artisticat1/obsidian-tikzjax (MIT), the build the
Obsidian TikZJax plugin ships, fetched 2026-07-17 from the `main` branch. Both
phones carried byte-identical copies in `public/tikzjax/` until this package.

A host serves these two files at `tikzjax/` beside its `index.html`
(`src/tikz.ts` loads `tikzjax/tikzjax.js` and `tikzjax/fonts.css` relative to
the page) and imports them as `@zennotes/portable-vault/tikzjax/*`. They load
lazily on the first TikZ render; nothing here is on the boot path.

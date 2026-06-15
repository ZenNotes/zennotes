import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const stylesSource = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8')

describe('editor and preview typography rhythm', () => {
  it('uses the same content line-height for editor and preview headings', () => {
    expect(stylesSource).toMatch(
      /\.cm-editor\s*\{[^}]*--z-heading-line-height:\s*var\(--z-editor-line-height,\s*1\.7\);/s
    )
    expect(stylesSource).toMatch(
      /\.prose-zen\s*\{[^}]*--z-heading-line-height:\s*var\(--z-editor-line-height,\s*1\.7\);/s
    )
  })

  it('maps preview block spacing to the shared split-view rhythm and removes extra editor heading padding', () => {
    expect(stylesSource).toMatch(/\.cm-editor\s*\{[^}]*--z-heading-bottom-gap:\s*0px;/s)
    expect(stylesSource).toMatch(
      /\.prose-zen\s*\{[^}]*--z-prose-line-gap:\s*calc\(var\(--z-editor-line-height,\s*1\.7\)\s*\*\s*1em\);/s
    )
    expect(stylesSource).toMatch(
      /\.prose-zen\s*\{[^}]*--z-prose-rendered-gap:\s*calc\(var\(--z-prose-line-gap\)\s*\*\s*0\.6\);/s
    )
    expect(stylesSource).toMatch(
      /\.prose-zen\s*\{[^}]*--z-prose-block-gap:\s*var\(--z-prose-rendered-gap\);/s
    )
    expect(stylesSource).toMatch(
      /\.prose-zen\s*\{[^}]*--z-prose-section-gap:\s*var\(--z-prose-rendered-gap\);/s
    )
    expect(stylesSource).toMatch(
      /\.prose-zen\s*\{[^}]*--z-prose-heading-gap:\s*var\(--z-prose-rendered-gap\);/s
    )
    expect(stylesSource).toMatch(/\.prose-zen h1\s*\{[^}]*margin-bottom:\s*var\(--z-prose-heading-gap\);/s)
    expect(stylesSource).toMatch(/\.prose-zen h2\s*\{[^}]*margin-top:\s*var\(--z-prose-section-gap\);/s)
    expect(stylesSource).toMatch(/\.prose-zen h3\s*\{[^}]*margin-top:\s*var\(--z-prose-section-gap\);/s)
    expect(stylesSource).toMatch(/\.prose-zen h4\s*\{[^}]*margin-top:\s*var\(--z-prose-section-gap\);/s)
    expect(stylesSource).toMatch(/\.prose-zen h5\s*\{[^}]*margin-top:\s*var\(--z-prose-section-gap\);/s)
    expect(stylesSource).toMatch(/\.prose-zen h6\s*\{[^}]*margin-top:\s*var\(--z-prose-section-gap\);/s)
  })

  it('keeps editor heading lines free of vertical box-model offsets', () => {
    expect(stylesSource).not.toMatch(/\.cm-editor \.cm-heading-line-h1\s*\{[^}]*padding-(top|bottom):/s)
    expect(stylesSource).not.toMatch(/\.cm-editor \.cm-heading-line-h1\s*\{[^}]*margin-(top|bottom):/s)
    expect(stylesSource).not.toMatch(/\.cm-editor \.cm-heading-line-h1\s*\{[^}]*box-shadow:/s)
    expect(stylesSource).toMatch(
      /\.cm-editor \.cm-heading-h1-rhythm\s*\{[^}]*height:\s*calc\(var\(--z-editor-line-height,\s*1\.7\)\s*\*\s*2\.0em\);/s
    )
    expect(stylesSource).toMatch(
      /\.cm-wysiwyg \.cm-code-block-gap\s*\{[^}]*height:\s*calc\(var\(--z-editor-line-height,\s*1\.7\)\s*\*\s*0\.6em\);/s
    )
    expect(stylesSource).toMatch(
      /\.cm-wysiwyg \.cm-editor \.cm-heading-line-h1\s*\{[^}]*--z-heading-line-height:\s*1\.2;/s
    )
  })

  it('keeps rendered code blocks on the same text rhythm as the editor', () => {
    expect(stylesSource).toMatch(/\.prose-zen pre code\s*\{[^}]*font-size:\s*1em;/s)
    expect(stylesSource).toMatch(
      /\.prose-zen pre code\s*\{[^}]*line-height:\s*var\(--z-editor-line-height,\s*1\.7\);/s
    )
    expect(stylesSource).toMatch(
      /\.prose-zen \.zen-code-block\s*\{[^}]*--z-code-toolbar-line:\s*max\(var\(--z-prose-line-gap\),\s*28px\);/s
    )
    expect(stylesSource).toMatch(
      /\.prose-zen \.zen-code-block pre\s*\{[^}]*padding:\s*var\(--z-code-toolbar-line\)\s*16px\s*var\(--z-prose-line-gap\);/s
    )
  })

  it('keeps content letter spacing neutral', () => {
    expect(stylesSource).not.toMatch(/letter-spacing:\s*-/)
    expect(stylesSource).toMatch(
      /\.cm-editor \.tok-heading5\s*\{[^}]*letter-spacing:\s*0;/s
    )
    expect(stylesSource).toMatch(
      /\.prose-zen h1,\s*\.prose-zen h2,\s*\.prose-zen h3,\s*\.prose-zen h4,\s*\.prose-zen h5,\s*\.prose-zen h6\s*\{[^}]*letter-spacing:\s*0;/s
    )
    expect(stylesSource).toMatch(
      /\.prose-zen h5\s*\{[^}]*letter-spacing:\s*0;/s
    )
  })

  it('keeps search match highlights visible inside code blocks and inline code', () => {
    // Theme-aware background so the match shows against paper/dark themes.
    expect(stylesSource).toMatch(
      /\.cm-editor \.cm-searchMatch\s*\{[^}]*background:\s*rgb\(var\(--z-yellow\)\s*\/\s*0\.4\)\s*!important;/s
    )
    // Currently-focused match stands apart from the rest.
    expect(stylesSource).toMatch(
      /\.cm-editor \.cm-searchMatch-selected\s*\{[^}]*background:\s*rgb\(var\(--z-accent\)\s*\/\s*0\.5\)\s*!important;/s
    )
    // Inline-code chip background must not occlude the match highlight.
    expect(stylesSource).toMatch(
      /\.cm-editor \.cm-searchMatch \.tok-monospace\s*\{[^}]*background:\s*transparent\s*!important;/s
    )
  })

  it('styles the built-in CodeMirror search panel with app theme tokens', () => {
    expect(stylesSource).toMatch(
      /\.cm-editor \.cm-search\s*\{[^}]*background:\s*rgb\(var\(--z-bg-softer\)\)\s*!important;/s
    )
    expect(stylesSource).toMatch(
      /\.cm-editor \.cm-search \.cm-textfield\s*\{[^}]*background:\s*rgb\(var\(--z-bg\)\)\s*!important;/s
    )
    expect(stylesSource).toMatch(
      /\.cm-editor \.cm-search \.cm-button,\s*\.cm-editor \.cm-search button\[name="close"\]\s*\{[^}]*background:\s*rgb\(var\(--z-bg-2\)\)\s*!important;/s
    )
    expect(stylesSource).toMatch(
      /\.cm-editor \.cm-search input\[type="checkbox"\]:checked\s*\{[^}]*background:\s*rgb\(var\(--z-accent\)\);/s
    )
  })

  it('keeps expanded diagram SVGs visible inside the pan and zoom viewport', () => {
    expect(stylesSource).toMatch(
      /\.zen-diagram-pan-content\s*\{[^}]*width:\s*100%;/s
    )
    expect(stylesSource).toMatch(
      /\.zen-diagram-pan-content \.zen-diagram-modal-host\s*\{[^}]*width:\s*100%;/s
    )
    expect(stylesSource).toMatch(
      /\.zen-diagram-pan-content \.zen-diagram-surface-expanded > svg,\s*\.zen-diagram-pan-content \.mermaid svg\s*\{[^}]*width:\s*100%\s*!important;/s
    )
  })

  it('supports a fullscreen expanded diagram viewport', () => {
    expect(stylesSource).toMatch(
      /\.zen-diagram-modal-shell-fullscreen\s*\{[^}]*height:\s*calc\(100vh - 44px\);/s
    )
    expect(stylesSource).toMatch(
      /\.zen-diagram-modal-shell-fullscreen\s*\{[^}]*margin-top:\s*44px;/s
    )
    expect(stylesSource).toMatch(
      /\.zen-diagram-pan-viewport-fill\s*\{[^}]*height:\s*100%;/s
    )
    expect(stylesSource).toMatch(
      /\.zen-diagram-pan-viewport-fill\s*\{[^}]*min-height:\s*0;/s
    )
  })
})

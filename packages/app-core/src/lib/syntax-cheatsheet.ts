/**
 * Syntax Cheat Sheet — adapted from Payer's qa_viewer.html
 *
 * Provides structured data about available markdown syntax elements
 * for display in an interactive cheat sheet / syntax reference panel.
 *
 * Each category contains items with:
 *   - label:    The syntax example (code display)
 *   - before:   Text to insert before cursor (or wrapping selection)
 *   - after:    Text to insert after selection (empty = none)
 *   - desc:     Description (shown as tooltip / side label)
 */

export interface SyntaxItem {
  label: string
  before: string
  after: string
  desc: string
}

export interface SyntaxCategory {
  id: string
  title: string
  items: SyntaxItem[]
}

const CHEAT_SHEET: SyntaxCategory[] = [
  // ── Standard Markdown ──────────────────────────────────────
  {
    id: 'std',
    title: 'Standard Markdown',
    items: [
      {
        label: '# Title',
        before: '# ',
        after: '',
        desc: 'H1–H6',
      },
      {
        label: '**bold**',
        before: '**',
        after: '**',
        desc: 'Bold',
      },
      {
        label: '*italic*',
        before: '*',
        after: '*',
        desc: 'Italic',
      },
      {
        label: '`code`',
        before: '`',
        after: '`',
        desc: 'Inline code',
      },
      {
        label: '> Text',
        before: '\n> ',
        after: '',
        desc: 'Blockquote',
      },
      {
        label: '- Item',
        before: '\n- ',
        after: '',
        desc: 'List',
      },
      {
        label: '[Text](url)',
        before: '[',
        after: '](url)',
        desc: 'Link',
      },
      {
        label: '![Alt](path)',
        before: '![',
        after: '](path)',
        desc: 'Image',
      },
      {
        label: '| A | B |',
        before: '\n| A | B |\n|---|---|\n| ',
        after: ' | |',
        desc: 'Table',
      },
      {
        label: '---',
        before: '\n---\n',
        after: '',
        desc: 'Ruler',
      },
    ],
  },

  // ── Extensions (markdown-it / remark) ──────────────────────
  {
    id: 'ext',
    title: 'Extensions',
    items: [
      {
        label: ':br',
        before: ':br',
        after: '',
        desc: 'Line break',
      },
      {
        label: ':indent',
        before: ':indent',
        after: '',
        desc: 'Inline indent',
      },
      {
        label: '⟪Sanskrit⟫',
        before: '⟪',
        after: '⟫',
        desc: 'Sanskrit (red)',
      },
    ],
  },

  // ── Container Blocks ───────────────────────────────────────
  {
    id: 'cnt',
    title: 'Container Blocks',
    items: [
      {
        label: ':::grammarbox{title=...}',
        before: '\n:::grammarbox{title=""}\n',
        after: '\n:::',
        desc: 'Grammar (yellow)',
      },
      {
        label: ':::grammarbox2',
        before: '\n:::grammarbox2\n',
        after: '\n:::',
        desc: 'Grammar (orange)',
      },
      {
        label: ':::important',
        before: '\n:::important\n',
        after: '\n:::',
        desc: 'Important (violet)',
      },
      {
        label: ':::note-box',
        before: '\n:::note-box\n',
        after: '\n:::',
        desc: 'Note (gray)',
      },
      {
        label: ':::indent',
        before: '\n:::indent\n',
        after: '\n:::',
        desc: 'Indented',
      },
      {
        label: ':::center',
        before: '\n:::center\n',
        after: '\n:::',
        desc: 'Centered',
      },
      {
        label: ':::media',
        before: '\n:::media\n',
        after: '\n:::',
        desc: 'Image block',
      },
      {
        label: ':::deleteme-box',
        before: '\n:::deleteme-box\n',
        after: '\n:::',
        desc: 'Invisible',
      },
      {
        label: ':::no-header',
        before: '\n:::no-header\n',
        after: '\n:::',
        desc: 'Table no header',
      },
      {
        label: ':::compact',
        before: '\n:::compact\n',
        after: '\n:::',
        desc: 'Compact table',
      },
      {
        label: ':::laut-table',
        before: '\n:::laut-table\n',
        after: '\n:::',
        desc: 'Sound table',
      },
      {
        label: ':::metrik-schema',
        before: '\n:::metrik-schema\n',
        after: '\n:::',
        desc: 'Metrics',
      },
    ],
  },
]

/** Resolve a description. */
export function getItemDesc(item: SyntaxItem, _locale: string): string {
  return item.desc
}

/** Resolve a category title. */
export function getCategoryTitle(cat: SyntaxCategory, _locale: string): string {
  return cat.title
}

export default CHEAT_SHEET
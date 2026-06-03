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
  desc: Record<string, string> // locale → description
}

export interface SyntaxCategory {
  id: string
  title: Record<string, string> // locale → title
  items: SyntaxItem[]
}

const CHEAT_SHEET: SyntaxCategory[] = [
  // ── Standard Markdown ──────────────────────────────────────
  {
    id: 'std',
    title: {
      de: 'Standard Markdown',
      en: 'Standard Markdown',
      it: 'Markdown standard',
      fr: 'Markdown standard',
    },
    items: [
      {
        label: '# Titel',
        before: '# ',
        after: '',
        desc: { de: 'H1–H6', en: 'H1–H6', it: 'H1–H6', fr: 'H1–H6' },
      },
      {
        label: '**fett**',
        before: '**',
        after: '**',
        desc: { de: 'Fettdruck', en: 'Bold', it: 'Grassetto', fr: 'Gras' },
      },
      {
        label: '*kursiv*',
        before: '*',
        after: '*',
        desc: { de: 'Kursiv', en: 'Italic', it: 'Corsivo', fr: 'Italique' },
      },
      {
        label: '`code`',
        before: '`',
        after: '`',
        desc: { de: 'Inline-Code', en: 'Inline code', it: 'Codice inline', fr: 'Code inline' },
      },
      {
        label: '> Text',
        before: '\n> ',
        after: '',
        desc: { de: 'Blockquote', en: 'Blockquote', it: 'Blockquote', fr: 'Citation' },
      },
      {
        label: '- Item',
        before: '\n- ',
        after: '',
        desc: { de: 'Liste', en: 'List', it: 'Lista', fr: 'Liste' },
      },
      {
        label: '[Text](url)',
        before: '[',
        after: '](url)',
        desc: { de: 'Link', en: 'Link', it: 'Link', fr: 'Lien' },
      },
      {
        label: '![Alt](pfad)',
        before: '![',
        after: '](pfad)',
        desc: { de: 'Bild', en: 'Image', it: 'Immagine', fr: 'Image' },
      },
      {
        label: '| A | B |',
        before: '\n| A | B |\n|---|---|\n| ',
        after: ' | |',
        desc: { de: 'Tabelle', en: 'Table', it: 'Tabella', fr: 'Tableau' },
      },
      {
        label: '---',
        before: '\n---\n',
        after: '',
        desc: { de: 'Trennlinie', en: 'Ruler', it: 'Linea', fr: 'Ligne' },
      },
    ],
  },

  // ── Extensions (markdown-it / remark) ──────────────────────
  {
    id: 'ext',
    title: {
      de: 'Erweiterungen (Payer)',
      en: 'Extensions (Payer)',
      it: 'Estensioni (Payer)',
      fr: 'Extensions (Payer)',
    },
    items: [
      {
        label: '[[br]]',
        before: '[[br]]',
        after: '',
        desc: { de: 'Zeilenumbruch', en: 'Line break', it: 'A capo', fr: 'Saut de ligne' },
      },
      {
        label: '[[indent]]',
        before: '[[indent]]',
        after: '',
        desc: { de: 'Einzug inline', en: 'Inline indent', it: 'Rientro inline', fr: 'Retrait inline' },
      },
      {
        label: '⟪text⟫',
        before: '⟪',
        after: '⟫',
        desc: { de: 'Sanskrit (rot)', en: 'Sanskrit (red)', it: 'Sanscrito (rosso)', fr: 'Sanskrit (rouge)' },
      },
    ],
  },

  // ── Container-Blöcke ───────────────────────────────────────
  {
    id: 'cnt',
    title: {
      de: 'Container-Blöcke',
      en: 'Container Blocks',
      it: 'Blocchi contenitore',
      fr: 'Blocs conteneurs',
    },
    items: [
      {
        label: '::: grammar-box{title=...}',
        before: '\n:::grammar-box{title=""}\n',
        after: '\n:::',
        desc: { de: 'Grammatik (gelb)', en: 'Grammar (yellow)', it: 'Grammatica (giallo)', fr: 'Grammaire (jaune)' },
      },
      {
        label: '::: grammar-box2',
        before: '\n:::grammar-box2\n',
        after: '\n:::',
        desc: { de: 'Grammatik (orange)', en: 'Grammar (orange)', it: 'Grammatica (arancione)', fr: 'Grammaire (orange)' },
      },
      {
        label: '::: important',
        before: '\n:::important\n',
        after: '\n:::',
        desc: { de: 'Wichtig (violett)', en: 'Important (violet)', it: 'Importante (viola)', fr: 'Important (violet)' },
      },
      {
        label: '::: note-box',
        before: '\n:::note-box\n',
        after: '\n:::',
        desc: { de: 'Notiz (grau)', en: 'Note (gray)', it: 'Nota (grigio)', fr: 'Note (gris)' },
      },
      {
        label: '::: indent',
        before: '\n:::indent\n',
        after: '\n:::',
        desc: { de: 'Eingerückt', en: 'Indented', it: 'Rientrato', fr: 'Indenté' },
      },
      {
        label: '::: center',
        before: '\n:::center\n',
        after: '\n:::',
        desc: { de: 'Zentriert', en: 'Centered', it: 'Centrato', fr: 'Centré' },
      },
      {
        label: '::: media',
        before: '\n:::media\n',
        after: '\n:::',
        desc: { de: 'Bild-Block', en: 'Image block', it: 'Blocco immagine', fr: 'Bloc image' },
      },
      {
        label: '::: deleteme-box',
        before: '\n:::deleteme-box\n',
        after: '\n:::',
        desc: { de: 'Unsichtbar', en: 'Invisible', it: 'Invisibile', fr: 'Invisible' },
      },
      {
        label: '::: no-header',
        before: '\n:::no-header\n',
        after: '\n:::',
        desc: { de: 'Tabelle o. Kopf', en: 'Table no header', it: 'Tabella senza intestazione', fr: 'Tableau sans en-tête' },
      },
      {
        label: '::: compact',
        before: '\n:::compact\n',
        after: '\n:::',
        desc: { de: 'Enge Tabelle', en: 'Compact table', it: 'Tabella compatta', fr: 'Tableau compact' },
      },
      {
        label: '::: laut-table',
        before: '\n:::laut-table\n',
        after: '\n:::',
        desc: { de: 'Laut-Tabelle', en: 'Sound table', it: 'Tabella fonemi', fr: 'Tableau phonèmes' },
      },
      {
        label: '::: metrik-schema',
        before: '\n:::metrik-schema\n',
        after: '\n:::',
        desc: { de: 'Metrik', en: 'Metrics', it: 'Metrica', fr: 'Métrique' },
      },
    ],
  },
]

/** Resolve a description for the given locale, with fallback to English then German. */
export function getItemDesc(item: SyntaxItem, locale: string): string {
  return item.desc[locale] ?? item.desc['en'] ?? item.desc['de'] ?? ''
}

/** Resolve a category title for the given locale. */
export function getCategoryTitle(cat: SyntaxCategory, locale: string): string {
  return cat.title[locale] ?? cat.title['en'] ?? cat.title['de'] ?? ''
}

export default CHEAT_SHEET
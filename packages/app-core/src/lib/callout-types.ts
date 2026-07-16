/**
 * Single source of truth for Obsidian-style callout (admonition) types.
 *
 * Callouts are written as a blockquote whose first line is `> [!type] Title`.
 * The renderer (`remarkCallouts` in `markdown.ts`) and the live-preview
 * decorations (`cm-wysiwyg-blocks.ts`) color a callout by its *group*, while
 * the `[!type]` insert menu (`cm-callouts.ts`) offers the canonical types with
 * an icon and description.
 *
 * The color groups here mirror the CSS in `styles/index.css` — search
 * `data-callout` (Preview) and `cm-callout-` (Edit mode). CSS can't import this
 * list, so the alias→group lists are kept in sync by hand in those two blocks.
 */

/** The color families a callout can fall into. Each maps to one accent var. */
export type CalloutGroup = 'note' | 'tip' | 'question' | 'warning' | 'danger' | 'quote'

export interface CalloutTypeDef {
  /** Canonical `[!type]` keyword, lowercase. */
  type: string
  /** Label shown in the insert menu. */
  label: string
  /** Color family — drives the border/tint/title color. */
  group: CalloutGroup
  /** Emoji shown beside the type in the insert menu. */
  icon: string
  /** One-line description shown under the label in the insert menu. */
  description: string
  /** Alternate keywords that render the same and surface this entry when typed. */
  aliases: string[]
}

/**
 * The callout types offered by the `[!` insert menu, in menu order. Every type
 * a note might already use (including aliases from other Markdown apps) maps to
 * one of the six groups so it always renders with a sensible color.
 */
export const CALLOUT_TYPES: CalloutTypeDef[] = [
  {
    type: 'note',
    label: 'Note',
    group: 'note',
    icon: '📝',
    description: 'General note or aside',
    aliases: []
  },
  {
    type: 'info',
    label: 'Info',
    group: 'note',
    icon: 'ℹ️',
    description: 'Informational callout',
    aliases: []
  },
  {
    type: 'abstract',
    label: 'Abstract',
    group: 'note',
    icon: '📋',
    description: 'Summary or TL;DR',
    aliases: ['summary', 'tldr']
  },
  {
    type: 'tip',
    label: 'Tip',
    group: 'tip',
    icon: '💡',
    description: 'Helpful tip or hint',
    aliases: ['hint', 'important']
  },
  {
    type: 'success',
    label: 'Success',
    group: 'tip',
    icon: '✅',
    description: 'Success, done, or checked',
    aliases: ['check', 'done']
  },
  {
    type: 'question',
    label: 'Question',
    group: 'question',
    icon: '❓',
    description: 'Question, help, or FAQ',
    aliases: ['help', 'faq']
  },
  {
    type: 'example',
    label: 'Example',
    group: 'question',
    icon: '🔎',
    description: 'Example or walkthrough',
    aliases: []
  },
  {
    type: 'warning',
    label: 'Warning',
    group: 'warning',
    icon: '⚠️',
    description: 'Warning or caution',
    aliases: ['warn', 'caution', 'attention']
  },
  {
    type: 'danger',
    label: 'Danger',
    group: 'danger',
    icon: '⚡',
    description: 'Danger or critical error',
    aliases: ['error']
  },
  {
    type: 'bug',
    label: 'Bug',
    group: 'danger',
    icon: '🐛',
    description: 'Bug or known defect',
    aliases: []
  },
  {
    type: 'failure',
    label: 'Failure',
    group: 'danger',
    icon: '❌',
    description: 'Failure or missing item',
    aliases: ['fail', 'missing']
  },
  {
    type: 'quote',
    label: 'Quote',
    group: 'quote',
    icon: '❞',
    description: 'Quotation or citation',
    aliases: ['cite']
  }
]

/** Keyword (canonical type or alias, lowercase) → color group. */
const GROUP_BY_KEYWORD: Map<string, CalloutGroup> = (() => {
  const map = new Map<string, CalloutGroup>()
  for (const def of CALLOUT_TYPES) {
    map.set(def.type, def.group)
    for (const alias of def.aliases) map.set(alias, def.group)
  }
  return map
})()

/**
 * Resolve a `[!type]` keyword to its color group, mirroring the Preview and
 * Edit-mode CSS. Unknown types fall back to the neutral `note` group.
 */
export function calloutGroupFor(type: string): CalloutGroup {
  return GROUP_BY_KEYWORD.get(type.toLowerCase()) ?? 'note'
}

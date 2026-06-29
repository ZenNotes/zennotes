/**
 * Pretty `zen --help` rendering.
 *
 * No dependencies — just ANSI escape codes and box-drawing characters.
 * Colors are gated on TTY detection and the standard NO_COLOR /
 * FORCE_COLOR environment conventions, so piping stays clean and CI
 * logs stay legible. Width adapts to the terminal up to a cap so
 * descriptions don't sprawl across ultra-wide windows.
 */

import appPackage from '../../package.json'

const RESET = '\x1b[0m'
// Track the app version so `zen --version` matches the About page (#243),
// instead of a hand-maintained string that drifts every release.
const HELP_VERSION = appPackage.version
const TERMINAL_COLUMNS_FALLBACK = 80
const TERMINAL_COLUMNS_CAP = 100
const COMMAND_COLUMN_WIDTH = 26

function colorEnabled(): boolean {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true
  if (process.env.NO_COLOR) return false
  if (process.env.TERM === 'dumb') return false
  if (process.argv.includes('--no-color')) return false
  return process.stdout.isTTY === true
}

const USE_COLOR = colorEnabled()

function wrap(code: string, value: string): string {
  if (!USE_COLOR || !value) return value
  return `${code}${value}${RESET}`
}

const bold = (s: string): string => wrap('\x1b[1m', s)
const dim = (s: string): string => wrap('\x1b[2m', s)
const italic = (s: string): string => wrap('\x1b[3m', s)
const cyan = (s: string): string => wrap('\x1b[36m', s)
const yellow = (s: string): string => wrap('\x1b[33m', s)
const magenta = (s: string): string => wrap('\x1b[35m', s)

function termWidth(): number {
  const cols = process.stdout.columns ?? TERMINAL_COLUMNS_FALLBACK
  return Math.min(Math.max(cols, 60), TERMINAL_COLUMNS_CAP)
}

function pad(value: string, width: number): string {
  // visible length excludes ANSI codes; our command labels are
  // pre-styled so we measure the original string and re-style.
  const visible = value.replace(/\x1b\[[0-9;]*m/g, '')
  if (visible.length >= width) return value
  return value + ' '.repeat(width - visible.length)
}

function wrapLines(text: string, width: number): string[] {
  // Soft-wrap a single descriptive paragraph at word boundaries. We
  // only wrap plain text — the command name in the left column
  // doesn't get wrapped.
  if (text.length <= width) return [text]
  const words = text.split(/\s+/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!current) {
      current = word
      continue
    }
    if ((current + ' ' + word).length > width) {
      lines.push(current)
      current = word
    } else {
      current += ' ' + word
    }
  }
  if (current) lines.push(current)
  return lines
}

interface CommandRow {
  /** Left column, e.g. `list <flags>` or `read <path>`. */
  name: string
  /** Right column primary description. */
  description: string
  /** Optional flag hint shown in muted text under the description,
   *  e.g. `--folder <f>  --tag <t>  --json`. */
  flags?: string
}

const SECTIONS: Array<{ heading: string; rows: CommandRow[] }> = [
  {
    heading: 'NOTES',
    rows: [
      { name: 'list', description: 'List notes, most recent first', flags: '--folder <f>  --tag <t>  --limit <n>  --json' },
      { name: 'read <path>', description: 'Print a note body to stdout', flags: '--meta  --json' },
      { name: 'create', description: 'Create a new note. Body from --body or stdin', flags: '--title <t>  --folder inbox|quick|archive  --subpath <p>  --tag <t>  --body "..."|-' },
      { name: 'write <path>', description: 'Replace a note body. Destructive — prefer append', flags: '--body "..."|-' },
      { name: 'append <path>', description: 'Append text to the end of a note', flags: '--body "..."|-' },
      { name: 'prepend <path>', description: 'Insert text at the top, after frontmatter', flags: '--body "..."|-' },
      { name: 'rename <path>', description: 'Rename a note (filename only)', flags: '--to <new title>' },
      { name: 'move <path>', description: 'Move a note to a different folder', flags: '--folder <f>  --subpath <p>' },
      { name: 'archive <path>', description: 'Move a note into archive/' },
      { name: 'unarchive <path>', description: 'Move it back from archive/' },
      { name: 'trash <path>', description: 'Soft-delete; reversible via restore' },
      { name: 'restore <path>', description: 'Restore a trashed note to inbox' },
      { name: 'delete <path>', description: 'Permanent delete', flags: '--yes' },
      { name: 'duplicate <path>', description: 'Copy a note next to itself' }
    ]
  },
  {
    heading: 'SEARCH',
    rows: [
      { name: 'search <query>', description: 'Full-text search across live notes', flags: '--limit <n>  --json' },
      { name: 'search-title <q>', description: 'Match notes by title (substring)', flags: '--json' },
      { name: 'backlinks <path>', description: 'Notes linking to this one via [[wikilink]]', flags: '--json' }
    ]
  },
  {
    heading: 'FOLDERS',
    rows: [
      { name: 'folder list', description: 'List every subfolder in the vault', flags: '--json' },
      { name: 'folder create <p>', description: 'Create a subfolder, e.g. inbox/Work' },
      { name: 'folder rename <p>', description: 'Rename a subfolder in place', flags: '--to <newPath>' },
      { name: 'folder delete <p>', description: 'Delete a subfolder and everything in it', flags: '--yes' }
    ]
  },
  {
    heading: 'TAGS',
    rows: [
      { name: 'tag list', description: 'Every #tag with its note count', flags: '--json' },
      { name: 'tag find <tag>', description: 'Notes carrying this #tag', flags: '--limit <n>  --json' }
    ]
  },
  {
    heading: 'TASKS',
    rows: [
      { name: 'task list', description: 'Open checkbox tasks across all notes', flags: '--unchecked  --all  --tag <t>  --json' },
      { name: 'task toggle <id>', description: 'Flip a task checkbox by stable id' }
    ]
  },
  {
    heading: 'VAULT',
    rows: [
      { name: 'vault info', description: 'Vault path + per-folder counts', flags: '--json' },
      { name: 'vault list', description: 'Known vaults; the default is marked with *', flags: '--json' }
    ]
  },
  {
    heading: 'CAPTURE',
    rows: [
      { name: 'capture "..."', description: 'Quick add. Pipes stdin if no positional', flags: '--folder <f>  --tag <t>  --title <t>  --json' }
    ]
  },
  {
    heading: 'OPEN',
    rows: [
      { name: 'open <file.md>', description: 'Open markdown files in the ZenNotes app, in a vault or not' }
    ]
  },
  {
    heading: 'MCP',
    rows: [
      { name: 'mcp', description: 'Start the MCP stdio server (Claude / Codex)' }
    ]
  }
]

const GLOBAL_FLAGS: CommandRow[] = [
  { name: '--vault <name|path>', description: 'Target a specific vault (see `zen vault list`)' },
  { name: '--json', description: 'Emit machine-readable JSON output' },
  { name: '--no-color', description: 'Disable ANSI color even on a TTY' },
  { name: '--help, -h', description: 'Show this help' },
  { name: '--version', description: 'Print the CLI version' }
]

const ENVIRONMENT: CommandRow[] = [
  { name: 'ZENNOTES_VAULT', description: 'Default vault root when --vault is not given' },
  { name: 'ZENNOTES_CONFIG_DIR', description: 'Override the ZenNotes config directory' },
  { name: 'NO_COLOR', description: 'Disable ANSI color (industry standard)' }
]

const EXAMPLES: string[] = [
  'zen capture "Meeting takeaways" --tag work',
  'pbpaste | zen append "inbox/Daily.md" --body -',
  'zen search "deadline" --json | jq \'.[].path\'',
  'zen list --tag idea --limit 5',
  'zen list --vault work --limit 5',
  'zen task list --unchecked --tag work',
  'zen open ~/Downloads/notes.md'
]

function header(width: number): string[] {
  // Box-drawing header. The inner content is padded so the right edge
  // lines up regardless of color codes.
  const inner = width - 4
  const tagline = 'ZenNotes CLI · capture, search, edit your vault from any terminal'
  const titleLine = `${bold(cyan('zen'))} ${dim(`v${HELP_VERSION}`)}`
  const taglineWrapped = wrapLines(tagline, inner).map((l) => dim(l))
  const lines = [titleLine, ...taglineWrapped]
  const top = '╭' + '─'.repeat(width - 2) + '╮'
  const bottom = '╰' + '─'.repeat(width - 2) + '╯'
  const middle = lines.map((l) => '│ ' + pad(l, inner) + ' │')
  return [top, ...middle, bottom]
}

function section(heading: string, rows: CommandRow[], width: number): string[] {
  const out: string[] = []
  out.push(bold(yellow(heading)))
  const descWidth = width - COMMAND_COLUMN_WIDTH - 2
  for (const row of rows) {
    const namePainted = magenta(row.name)
    const descLines = wrapLines(row.description, descWidth)
    out.push('  ' + pad(namePainted, COMMAND_COLUMN_WIDTH) + descLines[0])
    for (const cont of descLines.slice(1)) {
      out.push('  ' + ' '.repeat(COMMAND_COLUMN_WIDTH) + cont)
    }
    if (row.flags) {
      const flagLines = wrapLines(row.flags, descWidth)
      for (const line of flagLines) {
        out.push('  ' + ' '.repeat(COMMAND_COLUMN_WIDTH) + dim(cyan(line)))
      }
    }
  }
  return out
}

function paragraph(lines: string[]): string[] {
  return ['', ...lines, '']
}

export function renderHelp(): string {
  const width = termWidth()
  const out: string[] = []
  out.push(...header(width))
  out.push('')
  out.push(bold(yellow('USAGE')))
  out.push('  ' + cyan('zen') + ' ' + magenta('<command>') + ' ' + dim('[arguments] [flags]'))
  out.push('')
  for (const s of SECTIONS) {
    out.push(...section(s.heading, s.rows, width))
    out.push('')
  }
  out.push(...section('GLOBAL FLAGS', GLOBAL_FLAGS, width))
  out.push('')
  out.push(...section('ENVIRONMENT', ENVIRONMENT, width))
  out.push('')
  out.push(bold(yellow('EXAMPLES')))
  for (const line of EXAMPLES) {
    out.push('  ' + dim('$') + ' ' + line)
  }
  out.push('')
  out.push(
    italic(dim('  Install `zen` from Settings → CLI in the ZenNotes app. Quote note paths that contain spaces.'))
  )
  out.push(italic(dim('  Run `zen <command>` to try one out.')))
  out.push('')
  return out.join('\n')
}

export function renderVersion(): string {
  return `${cyan(bold('zen'))} ${dim('v' + HELP_VERSION)}\n`
}

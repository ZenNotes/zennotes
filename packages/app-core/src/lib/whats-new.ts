/**
 * What's New: a window on the first launch after every update, and on demand
 * from the palette ("What’s New in ZenNotes") and `:whatsnew`.
 *
 * The highlights are bundled on purpose (Adib, 2026-10-12): the window works
 * offline and opens at once, and its copy is reviewed in the release PR like
 * the code it describes. Add an entry in the release PR of every release
 * worth announcing. An update across several versions shows each entry in
 * between, newest first; a version without one still opens the window, with
 * the Cloud card and the link to its release notes on the website.
 *
 * Desktop only: the phones announce through their stores, and a self-hosted
 * web app updates with its server.
 */

export type UsageCountEvent = 'install' | 'update'

export interface WhatsNewEntry {
  version: string
  highlights: ReadonlyArray<{ title: string; body: string }>
}

/** What the window shows. */
export interface WhatsNewView {
  /** The version the window is about: the one just installed. */
  version: string
  entries: WhatsNewEntry[]
  /** The Cloud card, left out for someone already on Cloud. */
  showCloud: boolean
}

/** The ZenNotes Cloud card: a fixture of every What's New, not one release's
 *  news (Adib, 2026-10-12). */
export const CLOUD_ANNOUNCEMENT = {
  title: 'ZenNotes Cloud',
  body: 'Keep your vaults in sync on every device, backed up every day, and publish notes to the web.',
  settingsLabel: 'Set up ZenNotes Cloud',
  link: { label: 'Plans and pricing', url: 'https://zennotes.org/pricing' }
} as const

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    version: '2.79.0',
    highlights: [
      {
        title: 'A timeline of what’s due',
        body: 'The Timeline panel lays every open task with a date down one line: overdue work in red, today, then each day that has work. Tag a task #milestone to mark it with a diamond. Mod+7, or Space n in Vim mode.'
      },
      {
        title: 'Any command can take a key',
        body: 'Every command in the palette can be given a key of its own, a leader sequence in Vim mode included. Highlight one and press Alt+Enter, or use the Commands group in Settings, Keymap.'
      },
      {
        title: 'Share to ZenNotes on macOS',
        body: 'Choose Share, ZenNotes in Safari or any app to save a page or the text you selected as a note. Each vault picks where shares land.'
      },
      {
        title: 'Unsplash covers with your own key',
        body: 'Add your Unsplash Access Key in Settings to search millions of photos for a note’s cover. Searches go straight from your computer to Unsplash, and the photo is credited to its photographer.'
      },
      {
        title: 'A folder as a Gallery',
        body: 'Open as Gallery on a folder shows its notes as cards by their covers, a letter for a note without one. Sort them, include subfolders, filter by title. Open Folder Gallery in the palette, :gallery, or Space G in Vim mode.'
      },
      {
        title: 'Callouts and code languages from a menu',
        body: 'Right-click lines to turn them into a callout, or a callout to change its type. A code block’s label now picks its language, and a block without one shows a detected language until you choose it.'
      },
      {
        title: 'Database views that show just what you need',
        body: 'Each table view keeps its own columns: the Columns button hides the rest of a wide CSV. The + makes new table views and copies, and Show only these in this view keeps the rows you selected.'
      }
    ]
  },
  {
    version: '2.78.0',
    highlights: [
      {
        title: 'Give a note a cover',
        body: 'A wide image across the top of a note, the way Notion draws one. Add Cover in the command palette, or Space l c in Vim mode, opens the picker: gradients, public-domain photos, your own images or a link. Hover it to reposition or remove it.'
      },
      {
        title: 'Covers stay plain Markdown',
        body: 'A cover is saved as banner frontmatter, the key Obsidian’s banner plugins read, and its image is an ordinary file in your assets folder. Published notes and Quick Look show it too.'
      },
      {
        title: 'Math in diagram labels',
        body: 'Mermaid labels typeset $$ math, as on mermaid.live and GitHub, and text on a node’s own fill picks dark or light to stay readable in every theme.'
      },
      {
        title: 'LaTeX in the terminal',
        body: 'The bundled zn is 0.12.2: with math set to latex, its preview draws display math and TikZ through the TeX on your computer.'
      }
    ]
  },
  {
    version: '2.77.0',
    highlights: [
      {
        title: 'Links to notes you haven’t written yet',
        body: 'Unresolved Links lists every [[link]] in your vault that points at no note, most linked first, with the lines that link to it. Open it from the command palette, or with Space u in Vim mode.'
      },
      {
        title: 'Edit a linked note in place',
        body: 'Rest the pointer on a link and its note opens in a popover over yours: type, then Escape. A link to a missing note offers to create it right there. K in Vim mode, Shift+Cmd+K without.'
      },
      {
        title: 'Tags find the idea, not just the note',
        body: 'The Tags view lists the tagged blocks inside each note: a list item, a paragraph, or a whole section under a tagged heading. In Search notes, #idea does the same, and Enter jumps to the line.'
      },
      {
        title: 'Steadier on slow networks',
        body: 'ZenNotes Cloud retries a stalled request after 30 seconds instead of waiting five minutes, and a conflict review opens at once, even while a sync is running.'
      }
    ]
  },
  {
    version: '2.76.0',
    highlights: [
      {
        title: 'Any due date, two clicks away',
        body: 'Right-click a task in the Tasks list, on the board or in the calendar and pick Choose a date… for a month calendar: a click on a day sets it. In Vim mode, @ opens it on the selected task.'
      },
      {
        title: 'No due date has its own place',
        body: 'A task without a due date now waits under No due date, after Upcoming, instead of in Today. The Status board has the same column, and dropping a card there clears its date.'
      },
      {
        title: 'Tasks by priority',
        body: 'The Tasks list’s new Order menu puts high priority first inside each group, still grouped by date (s in Vim mode, or :order priority). Note order brings back your notes’ line order.'
      },
      {
        title: 'Cloud conflicts settle cleanly',
        body: 'Choosing the other device’s version no longer removes a note this device kept, and when a file already holds its place, that file moves beside it under the next free name.'
      }
    ]
  },
  {
    version: '2.75.0',
    highlights: [
      {
        title: 'Same name, different folder',
        body: 'Search notes (Cmd+P on macOS, Ctrl+P elsewhere) now shows the folder each result lives in, so notes that share a name are easy to tell apart. A long folder keeps its end in view.'
      },
      {
        title: 'Links in table cells',
        body: 'Type [[ in a table cell in Edit mode and the same note picker as in a paragraph opens: arrows or Ctrl+N and Ctrl+P to move, Enter to insert, | to add display text.'
      },
      {
        title: 'Deep notes keep their title',
        body: 'In a narrow pane, a note several folders deep now gives up its outer folders before its title, and renaming it shows the whole name from the start.'
      }
    ]
  },
  {
    version: '2.74.0',
    highlights: [
      {
        title: 'Every record, ready to link',
        body: 'Choose Create pages for all records in a database’s ⋯ menu, or press O in the grid with Vim on, to give every record its page at once, so each one can be linked. A page file already in the folder is linked, not copied.'
      },
      {
        title: 'Next and previous tab',
        body: 'Ctrl+PageDown and Ctrl+PageUp (Cmd+Option+Right and Left on macOS) step through your open tabs, with Vim on or off. Next Tab and Previous Tab are in the command palette too.'
      },
      {
        title: 'Plan days ahead',
        body: 'Follow a link like [[2026-11-03]] to a day with no note and it becomes that day’s daily note, from your template. Hover a day in the calendar to read its note without opening it.'
      }
    ]
  },
  {
    version: '2.73.0',
    highlights: [
      {
        title: 'Move the window without a title bar',
        body: 'With Window title bar turned off under Settings → Appearance → Chrome, drag blank space in the tab strip to move the window, as you would a title bar, even with the sidebar closed. The browser app gets the same switch, called Title bar.'
      },
      {
        title: 'Settings in a narrow window',
        body: 'Text fields, choices, font pickers, sliders and key bindings in Settings move under their label when the window or tablet is narrow, instead of squeezing the label into a column of single words.'
      },
      {
        title: 'Vim o and O in quotes',
        body: 'With Vim on, o and O on a line inside a quote or callout open the new line inside it, with the same quote marker and list marker Enter would give.'
      }
    ]
  },
  {
    version: '2.72.0',
    highlights: [
      {
        title: 'Task folders',
        body: 'Choose where tasks live: right-click a folder and pick Use as Task Folder, and only the notes in your Task folders feed Tasks, the boards and the calendars. Every other checkbox stays a plain checkbox. Both folder lists are under Settings → Tasks → Checklists.'
      },
      {
        title: 'Cloud errors you can act on',
        body: 'When Cloud has a problem, it now says what happened, whether it was on Cloud’s side or yours, and what to do. The technical line is under Details in Settings → Cloud, with Copy details and Report an Issue.'
      },
      {
        title: 'Back after months away',
        body: 'A device that last synced longer ago than Cloud keeps its change log now catches up by itself, keeping the edits you made while it was away and asking about anything changed on both sides.'
      },
      {
        title: 'Pickers and callouts',
        body: 'The sidebar’s icon and color pickers move with the arrow keys, and h j k l with Vim on. A math or code block you open inside a callout keeps every line in the callout.'
      }
    ]
  },
  {
    version: '2.71.0',
    highlights: [
      {
        title: 'Diagrams in your theme',
        body: 'Mermaid diagrams now draw with Pele, about 50 times faster and in your theme’s colours, from the same fences. With live preview on they draw right in the editor, and switching themes repaints them at once.'
      },
      {
        title: 'D2 diagrams',
        body: 'A d2 fence draws a D2 diagram: boxes inside boxes, labelled connections, data models and sequence diagrams, in your theme. The tour note 05c D2 Diagrams has examples to try.'
      },
      {
        title: 'Keep running in the tray',
        body: 'Turn it on in Settings → Appearance → Window, and closing the last window hides it instead of quitting: Cloud keeps syncing and the Quick capture hotkey keeps working. The tray icon brings the window back.'
      },
      {
        title: 'A fresh demo tour',
        body: 'Generate Demo Tour Notes now writes 22 notes, with new ones on task boards, templates, drawings and databases, workflows, and Cloud and the CLI. Regenerate it from the command palette to see what ZenNotes does today.'
      }
    ]
  },
  {
    version: '2.70.0',
    highlights: [
      {
        title: 'React to task changes',
        body: 'The zn CLI that ZenNotes bundles on macOS and Linux is now 0.8.0. Its zn task watch prints a line each time a task’s status changes, so a script can act the moment a card moves to another column.'
      },
      {
        title: 'Assistants see the column',
        body: 'Through MCP, list_tasks now gives each task’s status: the column it sits in when the Kanban board is grouped by Custom status.'
      },
      {
        title: 'Quick capture with Vim',
        body: 'The Quick capture window’s shortcuts now work while Vim is in normal mode: Ctrl+P and Ctrl+N everywhere, and Ctrl+W on Linux and Windows. Its note picker shows each note’s name first and keeps the selection in view.'
      },
      {
        title: 'Ctrl+P in Search Notes',
        body: 'On Linux and Windows, Ctrl+P in Search Notes moves the selection up, as in every other list, instead of closing it. Escape closes it.'
      }
    ]
  },
  {
    version: '2.69.1',
    highlights: [
      {
        title: 'Renames on Windows',
        body: 'Renaming a note or an attachment to a name another one already has now always stops and says so on Windows, instead of sometimes replacing the other file.'
      }
    ]
  },
  {
    version: '2.69.0',
    highlights: [
      {
        title: 'Assistants reach your server',
        body: 'Settings → MCP → Server token lets Claude, Codex and other assistants use a ZenNotes Server that needs a token, with no terminal step.'
      },
      {
        title: 'Which Claude, which tab',
        body: 'The MCP integrations say which part of the Claude app they reach: its Code tab uses the Claude Code entry.'
      },
      {
        title: 'Setup for a server vault',
        body: 'Connecting to a ZenNotes Server during setup skips the layout step: the server’s vault already has one.'
      },
      {
        title: 'Clearer keys for a new note',
        body: 'The New note form in search names the keys that work in the field you are in.'
      },
      {
        title: 'Encrypted vaults say so',
        body: 'A Cloud vault that another device encrypted end to end reads as encrypted, not deleted.'
      }
    ]
  },
  {
    version: '2.68.0',
    highlights: [
      {
        title: 'Review an assistant’s edits',
        body: 'When Claude Code, Codex or another assistant changes a note through MCP, review each change in the note itself and keep or undo it.'
      },
      {
        title: 'Windows on ARM',
        body: 'A native build for Snapdragon and other ARM PCs, so ZenNotes no longer runs through emulation there.'
      },
      {
        title: 'Links on Windows',
        body: 'zennotes:// links open ZenNotes on Windows, and connecting ZenNotes Cloud finishes there.'
      },
      {
        title: 'Headings stay headings',
        body: 'Tab no longer turns a heading into a code block.'
      },
      {
        title: 'Table widths in Preview',
        body: 'Column widths you set in the editor carry into Preview, and a wide table scrolls instead of squeezing its columns.'
      }
    ]
  }
]

/** The version's entry on the website's releases page (an anchor per release). */
export const RELEASE_NOTES_URL = (version: string): string => `https://zennotes.org/releases#v${version}`

/** Dotted numeric parts compared left to right; a prerelease suffix
 *  (`2.68.0-beta.1`) sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { parts: number[]; pre: string } => {
    const [core, ...rest] = v.replace(/^v/, '').split('-')
    return { parts: core.split('.').map((p) => Number.parseInt(p, 10) || 0), pre: rest.join('-') }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i += 1) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

/** The entries newer than `after` (all when null) up to `current`, newest first. */
export function whatsNewBetween(
  after: string | null,
  current: string,
  entries: readonly WhatsNewEntry[] = WHATS_NEW
): WhatsNewEntry[] {
  return entries
    .filter(
      (e) =>
        compareVersions(e.version, current) <= 0 &&
        (after === null || compareVersions(e.version, after) > 0)
    )
    .sort((a, b) => compareVersions(b.version, a.version))
}

/**
 * What the first launch of `current` does. `updated` opens the window. A fresh
 * install sees nothing (the onboarding is its welcome) but records the
 * version. A returning user who has never seen the window, because they come
 * from a version without it, gets every entry up to `current`; otherwise the
 * entries since the version they last saw. A downgrade shows nothing and
 * records the version, so the way back up opens the window again.
 *
 * `count` is the event for the anonymous usage count (Settings > About): once
 * per fresh install, once per update, nothing for a relaunch or a downgrade.
 */
export function whatsNewAtLaunch(input: {
  lastSeen: string | null
  current: string
  returningUser: boolean
  entries?: readonly WhatsNewEntry[]
}): { updated: boolean; entries: WhatsNewEntry[]; record: boolean; count: UsageCountEvent | null } {
  const { lastSeen, current, returningUser, entries = WHATS_NEW } = input
  const none = { updated: false, entries: [] as WhatsNewEntry[] }
  if (lastSeen !== null && compareVersions(lastSeen, current) === 0) return { ...none, record: false, count: null }
  if (lastSeen === null && !returningUser) return { ...none, record: true, count: 'install' }
  if (lastSeen !== null && compareVersions(lastSeen, current) > 0) return { ...none, record: true, count: null }
  return { updated: true, entries: whatsNewBetween(lastSeen, current, entries), record: true, count: 'update' }
}

/** The palette's entries: this version's, or the newest at or below it, or
 *  (a development build ahead of its notes) the newest there is. */
export function whatsNewOnDemand(current: string, entries: readonly WhatsNewEntry[] = WHATS_NEW): WhatsNewEntry[] {
  const upToNow = whatsNewBetween(null, current, entries)
  if (upToNow.length) return upToNow.slice(0, 1)
  const newest = [...entries].sort((a, b) => compareVersions(b.version, a.version))[0]
  return newest ? [newest] : []
}

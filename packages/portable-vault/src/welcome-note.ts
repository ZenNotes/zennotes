/**
 * The note a brand-new vault is seeded with on the phones. The desktop demo tour
 * (16 numbered notes about reference panes and keymaps) overwhelmed and
 * confused first-time phone users: its recency-sorted tail even hid
 * the "Start Here" note from the Home screen. One warm, phone-focused note that
 * the shell opens automatically replaces it; the full tour stays one command
 * away for the curious.
 */

export const WELCOME_NOTE_PATH = 'inbox/Welcome to ZenNotes.md'

/** The seed's path once a Cloud join moved a vault's notes to its root. */
const WELCOME_NOTE_ROOT_PATH = 'Welcome to ZenNotes.md'

/**
 * SHA-256 of every text a phone has ever seeded, both shells' included.
 * WELCOME_NOTE_BODY's own hash joins this list whenever the text changes, and
 * none ever leaves: a vault seeded by that version may still be waiting for
 * its first Cloud link, and these bytes are what proves nobody wrote in it.
 */
const WELCOME_NOTE_SEED_SHA256 = new Set([
  '49be342021eadb1024c953dd4deff6bb11b55bfa3abadf48e31e5f70d80bdaa7',
  '510856badfc9ebe69be627f0b341f36f2cfeb836d252782e34b6132e90f43c35',
  '65e808990047a85fed1d0f66a096da837c88f337f0b0812fee6de83d56129658',
  'd0b1476aac87dc7276c0394cfb07748a55694c3309d7a03495f4bbeba61f2326',
  '45443b253ac253f0af68a29f0c4430888ea19b84d9757a797aacdc0d33a1fe72',
  '99a80fa71dc5365b0ca8fe78d4dc1abc1f66a060de705e630244a2274fb7177e',
  'e7ef768d3df8d6da56b614e2bc9fcaa3e374c31acde7a222baa871495c775e06',
  'b7a57b91f73ceb738d20a3b18f6b7381ac17679d5b59ee21a21b59741782309a',
  '411229cbda35559d4722497eb8981e273a2c87d9efcc403980305cb435faadc7',
  '9efef627db5ae07699ee6854e2b0f927f2d57a324a55624d49a71f7858690dc3',
  '47226807945dc6e94656b2ebfb5d4fb7fdadfa43540874c3078e4a1793888383',
  'edf94b0e37a1f8d197b7f2397a7f50ac3bf96bcbb3819ce1f488f4bdaa03d5ad',
  'c7d21d00293038e3d366dfb31397300ca7bf7429f2eb8cc3f097576a83818e0d'
])

/** Whether this file is still the seed exactly as the app wrote it. */
export function isUntouchedWelcomeSeed(path: string, sha256: string): boolean {
  return (path === WELCOME_NOTE_PATH || path === WELCOME_NOTE_ROOT_PATH) && WELCOME_NOTE_SEED_SHA256.has(sha256)
}

/**
 * SHA-256 of every `inbox/Welcome.md` the desktop app has seeded, copied from
 * WELCOME_SEED_SHA256 in its apps/desktop/src/main/vault.ts (ZenNotes 4e8c13f8).
 * A desktop vault can reach this app through iCloud or a picked folder, and its
 * Welcome is just as untouched. The two lists grow apart, never shrink.
 */
const DESKTOP_WELCOME_SEED_SHA256 = new Set([
  '50c264c87b2790dbb685cd9a699118e1d62e84eb5532701e96d5b1ab55373fac',
  'a5d1b711723c817947c48b844ddc789b9889ce13645a060f33e6e6c4362cf1af',
  'f1d62f8864688c0c51d627c1156c8a00b0c3925eddf0678dfe3da84dd5e6a9e8',
  '04fabc332abe4b892d548782ecfcec27b77cf157ec59c7f0663b5774fae01aa9'
])

/** The name a seeded Welcome has inside `inbox/`, this app's or the desktop's. */
export function isWelcomeSeedName(name: string): boolean {
  return name === 'Welcome to ZenNotes.md' || name === 'Welcome.md'
}

/** Whether `inbox/<name>` holding these bytes is a Welcome nobody wrote in. */
export function isUntouchedInboxWelcome(name: string, sha256: string): boolean {
  if (name === 'Welcome to ZenNotes.md') return WELCOME_NOTE_SEED_SHA256.has(sha256)
  if (name === 'Welcome.md') return DESKTOP_WELCOME_SEED_SHA256.has(sha256)
  return false
}

export async function sha256OfText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const WELCOME_NOTE_BODY = `# Welcome to ZenNotes

This is your first note. It is yours: edit it, add to it, or delete it once you have found your feet.

## The circle

The small circle in the bottom corner is how you get around. Tap it:

- **Quick**, **Note**, or **Task**: start one with a single tap
- **New…**: everything you can create, templates and folders included
- **Search**: find anything, instantly
- **Browse**: your folders, tasks, and tags
- **More**: everything else, including Settings

## Try it now

- [ ] Tap this checkbox to tick it off
- [ ] Tap the circle, then **Note**, and write down a thought
- [ ] Tap the circle, then **Task**, and add something to do
- [ ] Tap the circle, then **Browse**, to see your folders

## Just plain text

Every note is a plain Markdown file: **bold**, *italic*, lists, and checkboxes are all simple text. No database, no lock-in. Your notes stay readable anywhere, forever.

## Organize with tags and folders

Type \`#\` in any note to tag it, like #ideas on this one. Tags appear under **Browse → Tags** the moment you write them.

Folders work the way you expect: create one in **Browse → New folder**, start a note inside the folder you are in with **New note** just above it, and move any note with the circle → **More** → **Move to…**.

## Capture from anywhere

Reading something worth keeping? Share it from any app and choose **ZenNotes**. It lands in your notes, ready when you are.

## Where your notes live

You picked a home for your notes when you first opened the app. To move between **iCloud** and this device, or to keep several vaults and switch between them, tap the circle → **More** → **Settings** → **Vault**.

## When you want more

ZenNotes also does math, diagrams, tables, tasks with due dates, and daily notes. For a folder of example notes showing everything, tap the circle → **More** → **All commands…** and run **Generate demo tour**.

Happy writing.
`

/**
 * The same note for an iPad. A tablet has the sidebar, not the phone's circle,
 * so its directions name the sidebar's own buttons.
 */
export const WELCOME_NOTE_TABLET_BODY = `# Welcome to ZenNotes

This is your first note. It is yours: edit it, add to it, or delete it once you have found your feet.

## The sidebar

The sidebar on the left is how you get around:

- **Search**: find anything, instantly
- The buttons beside Search: a new note or a new folder
- **Tasks**, **Quick Notes**, your folders, and your tags
- **Commands**, at the bottom: everything ZenNotes can do, by name
- **Settings** and **Help**, next to it

## Try it now

- [ ] Tap this checkbox to tick it off
- [ ] Tap **New note** on the Home screen and write down a thought
- [ ] Type \`- [ ]\` and a few words on a new line to add a task, then open **Tasks** in the sidebar
- [ ] Tap **Search** and type "welcome" to find this note again

## Just plain text

Every note is a plain Markdown file: **bold**, *italic*, lists, and checkboxes are all simple text. No database, no lock-in. Your notes stay readable anywhere, forever.

## Organize with tags and folders

Type \`#\` in any note to tag it, like #ideas on this one. Tags appear in the sidebar the moment you write them.

Folders work the way you expect: create one with the new folder button beside **Search**, and move a note with **Commands** → **Move Note to Folder…**.

## Capture from anywhere

Reading something worth keeping? Share it from any app and choose **ZenNotes**. It lands in your notes, ready when you are.

## Where your notes live

You picked a home for your notes when you first opened the app. To move between **iCloud** and this device, or to keep several vaults and switch between them, open **Settings** at the bottom of the sidebar → **Vault**.

## When you want more

ZenNotes also does math, diagrams, tables, tasks with due dates, and daily notes. For a folder of example notes showing everything, tap **Commands** and run **Generate Demo Tour Notes**.

Happy writing.
`

/**
 * Android's Welcome, phone and tablet. It says where an Android vault lives
 * (no iCloud), shows the math a Welcome there has always shown, and points a
 * tablet's keyboard at Ctrl+Shift+P instead of the iPad's Commands row. Both
 * shells' seeds share WELCOME_NOTE_SEED_SHA256, so a vault seeded on either
 * is held back from its first Cloud link the same way.
 */
export const WELCOME_NOTE_ANDROID_BODY = `# Welcome to ZenNotes

This is your first note. It is yours: edit it, add to it, or delete it once you have found your feet.

## The circle

The small circle in the bottom corner is how you get around. Tap it:

- **Quick**, **Note**, or **Task**: start one with a single tap
- **New…**: everything you can create, templates and folders included
- **Search**: find anything, instantly
- **Browse**: your folders, tasks, and tags
- **More**: everything else, including Settings

## Try it now

- [ ] Tap this checkbox to tick it off
- [ ] Tap the circle, then **Note**, and write down a thought
- [ ] Tap the circle, then **Task**, and add something to do
- [ ] Tap the circle, then **Browse**, to see your folders

## Just plain text

Every note is a plain Markdown file: **bold**, *italic*, lists, and checkboxes are all simple text. No database, no lock-in. Your notes stay readable anywhere, forever.

## Organize with tags and folders

Type \`#\` in any note to tag it, like #ideas on this one. Tags appear under **Browse → Tags** the moment you write them.

Folders work the way you expect: create one in **Browse → New folder**, start a note inside the folder you are in with **New note** just above it, and move any note with the circle → **More** → **Move to…**.

## Math that renders live

KaTeX equations, straight from plain markdown. Inline math like $e^{i\\pi} + 1 = 0$ or $A = \\pi r^2$ renders as you write, and display blocks get room to breathe:

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\, dx = \\sqrt{\\pi}
$$

## Capture from anywhere

Reading something worth keeping? Share it from any app and choose **ZenNotes**. It lands in your notes, ready when you are.

## Where your notes live

Your notes are plain files stored privately on this device. To keep several vaults and switch between them, or to connect a self-hosted ZenNotes server, tap the circle → **More** → **Settings** → **Vault**.

## When you want more

ZenNotes also does diagrams, tables, tasks with due dates, and daily notes. For a folder of example notes showing everything, tap the circle → **More** → **All commands…** and run **Generate demo tour**.

Happy writing.
`

export const WELCOME_NOTE_ANDROID_TABLET_BODY = `# Welcome to ZenNotes

This is your first note. It is yours: edit it, add to it, or delete it once you have found your feet.

## The sidebar

The sidebar on the left is how you get around:

- **Search**: find anything, instantly
- The buttons beside Search: a new note or a new folder
- **Tasks**, **Quick Notes**, your folders, and your tags
- **Settings** and **Help**, at the bottom

## Try it now

- [ ] Tap this checkbox to tick it off
- [ ] Tap **New note** on the Home screen and write down a thought
- [ ] Type \`- [ ]\` and a few words on a new line to add a task, then open **Tasks** in the sidebar
- [ ] Tap **Search** and type "welcome" to find this note again

## Just plain text

Every note is a plain Markdown file: **bold**, *italic*, lists, and checkboxes are all simple text. No database, no lock-in. Your notes stay readable anywhere, forever.

## Organize with tags and folders

Type \`#\` in any note to tag it, like #ideas on this one. Tags appear in the sidebar the moment you write them.

Folders work the way you expect: create one with the new folder button beside **Search**.

## Math that renders live

KaTeX equations, straight from plain markdown. Inline math like $e^{i\\pi} + 1 = 0$ or $A = \\pi r^2$ renders as you write, and display blocks get room to breathe:

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\, dx = \\sqrt{\\pi}
$$

## Capture from anywhere

Reading something worth keeping? Share it from any app and choose **ZenNotes**. It lands in your notes, ready when you are.

## Where your notes live

Your notes are plain files stored privately on this device. To keep several vaults and switch between them, or to connect a self-hosted ZenNotes server, open **Settings** at the bottom of the sidebar → **Vault**.

## When you want more

ZenNotes also does diagrams, tables, tasks with due dates, and daily notes. For a folder of example notes showing everything, press Ctrl+Shift+P on a keyboard and run **Generate Demo Tour Notes**.

Happy writing.
`

/** The Welcome note for this platform and the layout the device opens in. */
export function welcomeNoteBody(phoneLayout: boolean, platform: 'ios' | 'android'): string {
  if (platform === 'android') return phoneLayout ? WELCOME_NOTE_ANDROID_BODY : WELCOME_NOTE_ANDROID_TABLET_BODY
  return phoneLayout ? WELCOME_NOTE_BODY : WELCOME_NOTE_TABLET_BODY
}

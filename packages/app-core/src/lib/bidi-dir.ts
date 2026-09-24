// Right-to-left text-direction support for the editor and preview.
//
// ZenNotes has no `dir` handling by default. These helpers decide a note's
// effective direction: a global pref (`rtlMode`) picks off/auto/on, an auto
// note falls back to a body heuristic, and a frontmatter `dir:` field
// overrides detection for that note.
import {
  FRONTMATTER_BLOCK_RE,
  parseFrontmatterFields
} from '@shared/frontmatter'

/** RTL strong-directional code-point ranges (Hebrew, Arabic, supplementary
 *  Arabic, presentation forms). Everything here is BMP, so a code-unit
 *  test is sufficient. */
const RTL_RE =
  /[֐-׿؀-ۿݐ-ݿࢠ-ࣿיִ-ﭏﭐ-﷏ﷰ-﷿ﹰ-﻿]/

/** LTR strong char: ASCII + Latin-1 + Greek/Cyrillic + CJK + Hangul. CJK
 *  counts as LTR because CJK text lays out left-to-right. */
const LTR_RE =
  /[A-Za-zÀ-ɏͰ-ϿЀ-ӿḀ-ỿ一-鿿가-힯]/

/** Direction of the first strong-directional character on a line. Lines with
 *  only weak/neutral characters (markup, numbers, punctuation) return null. */
function lineDirection(line: string): 'rtl' | 'ltr' | null {
  for (const ch of line) {
    if (RTL_RE.test(ch)) return 'rtl'
    if (LTR_RE.test(ch)) return 'ltr'
  }
  return null
}

/** Heuristic: does the note body read right-to-left? Strips the frontmatter
 *  block (the `dir:` line itself must not bias the vote), skips fenced code
 *  (code is always LTR), then counts non-empty lines by their first strong
 *  character. Majority RTL wins; ties read LTR. */
export function detectRtl(body: string): boolean {
  const text = body.replace(FRONTMATTER_BLOCK_RE, '')
  let rtl = 0
  let ltr = 0
  let inFence = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const d = lineDirection(line)
    if (d === 'rtl') rtl += 1
    else if (d === 'ltr') ltr += 1
  }
  return rtl > ltr
}

/** Frontmatter `dir:` override: `rtl`/`ltr` return themselves; `auto`,
 *  a typo, or an absent field returns null so detection decides. */
export function noteRtlOverride(body: string): 'rtl' | 'ltr' | null {
  const m = FRONTMATTER_BLOCK_RE.exec(body)
  if (!m) return null
  const v = parseFrontmatterFields(m[1] ?? '').dir
  if (v === 'rtl') return 'rtl'
  if (v === 'ltr') return 'ltr'
  return null
}

/** Resolve a note's effective direction from the global mode. */
export function resolveNoteDirection(
  body: string,
  rtlMode: 'off' | 'auto' | 'on'
): 'ltr' | 'rtl' {
  if (rtlMode === 'on') return 'rtl'
  if (rtlMode === 'off') return 'ltr'
  return noteRtlOverride(body) ?? (detectRtl(body) ? 'rtl' : 'ltr')
}

import type { VaultTask } from '@shared/tasks'

// Every task state, so the "lossless" promise below actually holds for a `[>]`
// or `[/]` task too: an unmatched prefix falls back to the token-stripped
// `content`, which an inline edit would then write back over the real line.
// (#512)
const TASK_PREFIX_RE = /^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[[ xX>/-]\]\s?/

/** The raw text after the checkbox (content + any `due:`/`!priority` tokens):
 *  what an inline edit field prefills with so editing is lossless. Shared by
 *  the calendar panel and the Timeline panel, the two surfaces that edit a
 *  task in place. */
export function taskTail(task: VaultTask): string {
  const m = task.rawText.match(TASK_PREFIX_RE)
  return m ? task.rawText.slice(m[0].length) : task.content
}

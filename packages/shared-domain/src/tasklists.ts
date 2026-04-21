// Shared markdown task-list primitives used by both the renderer (toggling
// checkboxes in the preview) and the main-process vault-wide task scanner.
// The index convention here MUST stay in lockstep with any parser that wants
// to round-trip a toggle — see `src/shared/tasks.ts`.

export const FENCE_RE = /^(\s*)(```|~~~)/
export const TASK_LINE_RE = /^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[)( |x|X)(\].*)$/

export function toggleTaskAtIndex(
  markdown: string,
  taskIndex: number,
  checked: boolean
): string {
  if (taskIndex < 0) return markdown

  const lines = markdown.split('\n')
  let currentTaskIndex = 0
  let inFence = false
  let fenceMarker: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = line.match(FENCE_RE)
    if (fenceMatch) {
      const marker = fenceMatch[2]
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (marker === fenceMarker) {
        inFence = false
        fenceMarker = null
      }
      continue
    }
    if (inFence) continue

    const taskMatch = line.match(TASK_LINE_RE)
    if (!taskMatch) continue
    if (currentTaskIndex !== taskIndex) {
      currentTaskIndex += 1
      continue
    }

    lines[i] = `${taskMatch[1]}${checked ? 'x' : ' '}${taskMatch[3]}`
    return lines.join('\n')
  }

  return markdown
}

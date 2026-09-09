export type CloudSyncMergeChoice = 'local' | 'cloud' | 'both'

export interface CloudSyncMergeConflict {
  id: string
  base_text: string
  local_text: string
  cloud_text: string
}

interface TextPart {
  type: 'text'
  text: string
}

interface ConflictPart {
  type: 'conflict'
  conflict: CloudSyncMergeConflict
}

export interface CloudSyncTextMerge {
  status: 'clean' | 'conflict'
  /** A complete safe preview. Unresolved changes initially use this device. */
  text: string
  conflicts: CloudSyncMergeConflict[]
  /**
   * Every text part that is followed by another part ends with a line break,
   * so parts can be concatenated as they are once each conflict has a choice.
   */
  parts: Array<TextPart | ConflictPart>
}

interface Edit {
  start: number
  end: number
  replacement: string[]
}

interface DiffOperation {
  type: 'equal' | 'insert' | 'delete'
  value: string
}

/** A side's body without its final line break, and what that break was. */
interface Body {
  text: string
  /** `null` when the side is empty and has no opinion about a final break. */
  terminator: string | null
}

const MAX_DETAILED_DIFF_LINES = 8_000
const MAX_DETAILED_DIFF_DISTANCE = 512

/**
 * A conservative line-based diff3. Independent changes are combined, equal
 * changes collapse, and overlapping changes remain explicit user choices.
 *
 * Lines are compared without their terminators so CRLF and LF sides agree,
 * which means an unterminated final line is "equal" to a terminated one. The
 * final line break is therefore decided separately: each body is merged
 * without it, and the side that changed it wins. Inside the merge, any text
 * that follows an unterminated line is joined with a line break, never glued
 * onto it.
 */
export function mergeCloudSyncText(
  baseText: string,
  localText: string,
  cloudText: string
): CloudSyncTextMerge {
  const lineBreak = inferredLineBreak(baseText, localText, cloudText)
  const base = body(baseText)
  const local = body(localText)
  const cloud = body(cloudText)
  const merged = mergeBodies(base.text, local.text, cloud.text, lineBreak)
  return withTrailingBreak(merged, trailingBreak(base, local, cloud))
}

export function resolveCloudSyncMerge(
  merge: CloudSyncTextMerge,
  choices: Readonly<Record<string, CloudSyncMergeChoice>>
): string {
  for (const conflict of merge.conflicts) {
    if (!choices[conflict.id]) {
      throw new Error('Choose which version to use for every highlighted change.')
    }
  }
  return render(merge.parts, choices)
}

function mergeBodies(
  baseText: string,
  localText: string,
  cloudText: string,
  lineBreak: string
): CloudSyncTextMerge {
  if (sameText(localText, cloudText)) return clean(localText)
  if (sameText(baseText, localText)) return clean(cloudText)
  if (sameText(baseText, cloudText)) return clean(localText)

  const base = lines(baseText)
  const localEdits = edits(base, lines(localText))
  const cloudEdits = edits(base, lines(cloudText))
  const parts: Array<TextPart | ConflictPart> = []
  let localIndex = 0
  let cloudIndex = 0
  let baseIndex = 0
  let conflictNumber = 0

  const appendText = (text: string): void => {
    if (!text) return
    const previous = parts.at(-1)
    if (previous?.type === 'text') previous.text = joinLines(previous.text, text, lineBreak)
    else parts.push({ type: 'text', text })
  }

  while (localIndex < localEdits.length || cloudIndex < cloudEdits.length) {
    const local = localEdits[localIndex]
    const cloud = cloudEdits[cloudIndex]

    if (local && cloud && editsOverlap(local, cloud)) {
      const localGroup: Edit[] = [local]
      const cloudGroup: Edit[] = [cloud]
      localIndex++
      cloudIndex++

      let expanded = true
      while (expanded) {
        expanded = false
        const nextLocal = localEdits[localIndex]
        if (nextLocal && cloudGroup.some((edit) => editsOverlap(nextLocal, edit))) {
          localGroup.push(nextLocal)
          localIndex++
          expanded = true
        }
        const nextCloud = cloudEdits[cloudIndex]
        if (nextCloud && localGroup.some((edit) => editsOverlap(nextCloud, edit))) {
          cloudGroup.push(nextCloud)
          cloudIndex++
          expanded = true
        }
      }

      const start = Math.min(
        ...localGroup.map((edit) => edit.start),
        ...cloudGroup.map((edit) => edit.start)
      )
      const end = Math.max(
        ...localGroup.map((edit) => edit.end),
        ...cloudGroup.map((edit) => edit.end)
      )
      appendText(base.slice(baseIndex, start).join(''))
      const localResult = applyEdits(base, start, end, localGroup, lineBreak)
      const cloudResult = applyEdits(base, start, end, cloudGroup, lineBreak)

      if (sameText(localResult, cloudResult)) {
        appendText(localResult)
      } else {
        conflictNumber++
        terminateLastText(parts, lineBreak)
        parts.push({
          type: 'conflict',
          conflict: {
            id: `change-${conflictNumber}`,
            base_text: base.slice(start, end).join(''),
            local_text: localResult,
            cloud_text: cloudResult
          }
        })
      }
      baseIndex = end
      continue
    }

    const next = earlierEdit(local, cloud)
    if (!next) break
    appendText(base.slice(baseIndex, next.edit.start).join(''))
    appendText(next.edit.replacement.join(''))
    baseIndex = next.edit.end
    if (next.side === 'local') localIndex++
    else cloudIndex++
  }

  appendText(base.slice(baseIndex).join(''))
  const conflicts = parts.flatMap((part) => (part.type === 'conflict' ? [part.conflict] : []))
  return {
    status: conflicts.length === 0 ? 'clean' : 'conflict',
    text: render(parts, Object.fromEntries(conflicts.map((conflict) => [conflict.id, 'local']))),
    conflicts,
    parts
  }
}

function clean(text: string): CloudSyncTextMerge {
  return {
    status: 'clean',
    text,
    conflicts: [],
    parts: text ? [{ type: 'text', text }] : []
  }
}

function render(
  parts: CloudSyncTextMerge['parts'],
  choices: Readonly<Record<string, CloudSyncMergeChoice>>
): string {
  let output = ''
  for (const part of parts) {
    let chunk: string
    if (part.type === 'text') {
      chunk = part.text
    } else {
      const choice = choices[part.conflict.id]
      if (choice === 'cloud') chunk = part.conflict.cloud_text
      else if (choice === 'both') {
        chunk = joinBoth(part.conflict.local_text, part.conflict.cloud_text)
      } else chunk = part.conflict.local_text
    }
    output = joinLines(output, chunk, inferredLineBreak(output, chunk))
  }
  return output
}

function joinBoth(local: string, cloud: string): string {
  if (!local) return cloud
  if (!cloud || sameText(local, cloud)) return local
  return joinLines(local, cloud, inferredLineBreak(local, cloud))
}

/** Concatenate two runs of whole lines. A run whose last line is
 * unterminated gets a line break before anything follows it. */
function joinLines(left: string, right: string, lineBreak: string): string {
  if (!left || !right) return left + right
  return endsWithLineBreak(left) ? left + right : left + lineBreak + right
}

function terminateLastText(parts: CloudSyncTextMerge['parts'], lineBreak: string): void {
  const previous = parts.at(-1)
  if (previous?.type === 'text' && previous.text && !endsWithLineBreak(previous.text)) {
    previous.text += lineBreak
  }
}

function body(text: string): Body {
  if (!text) return { text: '', terminator: null }
  const match = /(?:\r\n|\n|\r)$/.exec(text)
  if (!match) return { text, terminator: '' }
  return { text: text.slice(0, text.length - match[0].length), terminator: match[0] }
}

function trailingBreak(base: Body, local: Body, cloud: Body): string {
  if (local.terminator === null) return cloud.terminator ?? ''
  if (cloud.terminator === null) return local.terminator
  if ((local.terminator === '') === (cloud.terminator === '')) return local.terminator
  const localKeptBase = (base.terminator === '') === (local.terminator === '')
  return localKeptBase ? cloud.terminator : local.terminator
}

function withTrailingBreak(merge: CloudSyncTextMerge, terminator: string): CloudSyncTextMerge {
  const last = merge.parts.at(-1)
  if (!terminator || !last) return merge
  if (last.type === 'text') {
    last.text += terminator
  } else {
    const conflict = last.conflict
    if (conflict.base_text) conflict.base_text += terminator
    if (conflict.local_text) conflict.local_text += terminator
    if (conflict.cloud_text) conflict.cloud_text += terminator
  }
  return {
    ...merge,
    text: render(
      merge.parts,
      Object.fromEntries(merge.conflicts.map((conflict) => [conflict.id, 'local']))
    )
  }
}

function inferredLineBreak(...values: string[]): string {
  return values.some((value) => value.includes('\r\n')) ? '\r\n' : '\n'
}

function endsWithLineBreak(value: string): boolean {
  return /[\r\n]$/.test(value)
}

function earlierEdit(
  local: Edit | undefined,
  cloud: Edit | undefined
): { side: 'local' | 'cloud'; edit: Edit } | null {
  if (!local && !cloud) return null
  if (!cloud) return { side: 'local', edit: local! }
  if (!local) return { side: 'cloud', edit: cloud }
  if (local.start !== cloud.start) {
    return local.start < cloud.start
      ? { side: 'local', edit: local }
      : { side: 'cloud', edit: cloud }
  }
  // An insertion at the start of a replacement is safely applied first.
  if (local.start === local.end && cloud.start !== cloud.end) {
    return { side: 'local', edit: local }
  }
  return { side: 'cloud', edit: cloud }
}

function editsOverlap(left: Edit, right: Edit): boolean {
  const leftInsert = left.start === left.end
  const rightInsert = right.start === right.end
  if (leftInsert && rightInsert) return left.start === right.start
  if (leftInsert) return left.start > right.start && left.start < right.end
  if (rightInsert) return right.start > left.start && right.start < left.end
  return Math.max(left.start, right.start) < Math.min(left.end, right.end)
}

function applyEdits(
  base: string[],
  start: number,
  end: number,
  values: Edit[],
  lineBreak: string
): string {
  let index = start
  let output = ''
  for (const edit of values.sort((left, right) => left.start - right.start)) {
    output = joinLines(output, base.slice(index, edit.start).join(''), lineBreak)
    output = joinLines(output, edit.replacement.join(''), lineBreak)
    index = edit.end
  }
  return joinLines(output, base.slice(index, end).join(''), lineBreak)
}

function edits(base: string[], target: string[]): Edit[] {
  if (base.length + target.length > MAX_DETAILED_DIFF_LINES) {
    return coarseEdit(base, target)
  }

  const operations = diff(base, target)
  if (operations === null) return coarseEdit(base, target)
  const result: Edit[] = []
  let baseIndex = 0
  let active: Edit | null = null
  const flush = (): void => {
    if (active) result.push(active)
    active = null
  }

  for (const operation of operations) {
    if (operation.type === 'equal') {
      flush()
      baseIndex++
      continue
    }
    active ??= { start: baseIndex, end: baseIndex, replacement: [] }
    if (operation.type === 'delete') {
      baseIndex++
      active.end = baseIndex
    } else {
      active.replacement.push(operation.value)
    }
  }
  flush()
  return result
}

function coarseEdit(base: string[], target: string[]): Edit[] {
  let prefix = 0
  while (prefix < base.length && prefix < target.length && sameLine(base[prefix], target[prefix])) {
    prefix++
  }
  let suffix = 0
  while (
    suffix < base.length - prefix &&
    suffix < target.length - prefix &&
    sameLine(base[base.length - suffix - 1], target[target.length - suffix - 1])
  ) {
    suffix++
  }
  if (prefix === base.length && prefix === target.length) return []
  return [
    {
      start: prefix,
      end: base.length - suffix,
      replacement: target.slice(prefix, target.length - suffix)
    }
  ]
}

function diff(base: string[], target: string[]): DiffOperation[] | null {
  const maximum = base.length + target.length
  let frontier = new Map<number, number>([[1, 0]])
  const trace: Array<Map<number, number>> = []

  for (
    let distance = 0;
    distance <= Math.min(maximum, MAX_DETAILED_DIFF_DISTANCE);
    distance++
  ) {
    trace.push(new Map(frontier))
    const next = new Map<number, number>()
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = value(frontier, diagonal + 1)
      const right = value(frontier, diagonal - 1) + 1
      let x = diagonal === -distance || (diagonal !== distance && right < down) ? down : right
      let y = x - diagonal
      while (x < base.length && y < target.length && sameLine(base[x], target[y])) {
        x++
        y++
      }
      next.set(diagonal, x)
      if (x >= base.length && y >= target.length) {
        return backtrack(trace, base, target)
      }
    }
    frontier = next
  }
  return null
}

function backtrack(
  trace: Array<Map<number, number>>,
  base: string[],
  target: string[]
): DiffOperation[] {
  const operations: DiffOperation[] = []
  let x = base.length
  let y = target.length

  for (let distance = trace.length - 1; distance >= 0; distance--) {
    const frontier = trace[distance]
    const diagonal = x - y
    const previousDiagonal =
      diagonal === -distance ||
      (diagonal !== distance && value(frontier, diagonal - 1) < value(frontier, diagonal + 1))
        ? diagonal + 1
        : diagonal - 1
    const previousX = value(frontier, previousDiagonal)
    const previousY = previousX - previousDiagonal

    while (x > previousX && y > previousY) {
      operations.push({ type: 'equal', value: base[x - 1] })
      x--
      y--
    }
    if (distance === 0) break
    if (x === previousX) {
      operations.push({ type: 'insert', value: target[y - 1] })
      y--
    } else {
      operations.push({ type: 'delete', value: base[x - 1] })
      x--
    }
  }

  return operations.reverse()
}

function value(frontier: Map<number, number>, diagonal: number): number {
  return frontier.get(diagonal) ?? Number.NEGATIVE_INFINITY
}

function lines(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? []
}

function sameText(left: string, right: string): boolean {
  return normalizeLineBreaks(left) === normalizeLineBreaks(right)
}

function sameLine(left: string, right: string): boolean {
  return stripLineBreak(left) === stripLineBreak(right)
}

function normalizeLineBreaks(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

function stripLineBreak(value: string): string {
  return value.replace(/(?:\r\n|\n|\r)$/, '')
}

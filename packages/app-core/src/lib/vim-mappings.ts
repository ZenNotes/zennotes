import type { KeymapDefinition } from './keymaps'

export type VimMode = 'normal' | 'visual' | 'insert'

export type VimMapCmd =
  | 'noremap'
  | 'map'
  | 'nnoremap'
  | 'nmap'
  | 'vnoremap'
  | 'vmap'
  | 'xnoremap'
  | 'xmap'
  | 'inoremap'
  | 'imap'

export type VimUnmapCmd = 'unmap' | 'nunmap' | 'vunmap' | 'xunmap' | 'iunmap'

export type AppliedVimMapping = { lhs: string; mode: VimMode }

export const VIM_MAP_CMD_MODES: Record<VimMapCmd, VimMode> = {
  noremap: 'normal',
  map: 'normal',
  nnoremap: 'normal',
  nmap: 'normal',
  vnoremap: 'visual',
  vmap: 'visual',
  xnoremap: 'visual',
  xmap: 'visual',
  inoremap: 'insert',
  imap: 'insert',
}

export const VIM_UNMAP_CMD_MODES: Record<VimUnmapCmd, VimMode> = {
  unmap: 'normal',
  nunmap: 'normal',
  vunmap: 'visual',
  xunmap: 'visual',
  iunmap: 'insert',
}

export const VIM_NOREMAP_CMDS = new Set<VimMapCmd>([
  'noremap',
  'nnoremap',
  'vnoremap',
  'xnoremap',
  'inoremap',
])

export const VIM_UNMAP_CMDS = new Set<VimUnmapCmd>([
  'unmap',
  'nunmap',
  'vunmap',
  'xunmap',
  'iunmap',
])

export type VimMappingDiagnosticKind =
  | 'unknown-command'
  | 'missing-rhs'
  | 'app-conflict'

export interface VimMappingDiagnostic {
  kind: VimMappingDiagnosticKind
  line: number
  message: string
  keymapId?: string
}

export function toVimKeyName(base: string): string {
  if (base === 'Space') return 'Space'
  if (base === 'Enter') return 'CR'
  if (base === 'Esc' || base === 'Escape') return 'Esc'
  if (base === 'Tab') return 'Tab'
  if (base === 'ArrowUp') return 'Up'
  if (base === 'ArrowDown') return 'Down'
  if (base === 'ArrowLeft') return 'Left'
  if (base === 'ArrowRight') return 'Right'
  return base
}

function toVimSequenceToken(token: string): string | null {
  const parts = token
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const base = parts.pop()
  if (!base) return null
  const keyName = toVimKeyName(base)
  if (parts.length === 0) {
    if (base.length === 1) return base
    return `<${keyName}>`
  }
  const modifiers = parts
    .map((part) => {
      if (part === 'Ctrl') return 'C'
      if (part === 'Alt') return 'A'
      if (part === 'Shift') return 'S'
      if (part === 'Meta' || part === 'Mod') return 'D'
      return null
    })
    .filter(Boolean) as string[]
  const normalizedKey = base.length === 1 ? base.toLowerCase() : keyName
  return `<${[...modifiers, normalizedKey].join('-')}>`
}

export function toVimSequence(binding: string): string | null {
  const tokens = binding
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => toVimSequenceToken(token))
  if (tokens.length === 0 || tokens.some((token) => !token)) return null
  return tokens.join('')
}

export function diagnoseVimMappings(
  raw: string,
  leaderKey: string,
  seqMap: Map<string, KeymapDefinition>,
): VimMappingDiagnostic[] {
  const resolve = (token: string): string =>
    token.replace(/<leader>/gi, leaderKey)

  const diagnostics: VimMappingDiagnostic[] = []

  raw.split('\n').forEach((line, idx) => {
    const lineNumber = idx + 1
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('"')) return

    const parts = trimmed.split(/\s+/)
    const cmd = parts[0]
    const rawLhs = parts[1]
    const rawRhs = parts[2]
    const lhs = rawLhs ? resolve(rawLhs) : undefined

    const isMapCmd = cmd in VIM_MAP_CMD_MODES
    const isUnmapCmd = VIM_UNMAP_CMDS.has(cmd as VimUnmapCmd)

    if (!isMapCmd && !isUnmapCmd) {
      diagnostics.push({
        kind: 'unknown-command',
        line: lineNumber,
        message: `Unknown command "${cmd}", only map/noremap/unmap variants are supported.`,
      })
      return
    }

    if (!lhs) return

    if (isMapCmd && !rawRhs) {
      diagnostics.push({
        kind: 'missing-rhs',
        line: lineNumber,
        message: `"${cmd} ${rawLhs}" is missing a right-hand side.`,
      })
      return
    }
    const def = seqMap.get(lhs)
    if (isMapCmd && def) {
      diagnostics.push({
        kind: 'app-conflict',
        line: lineNumber,
        message: `"${rawLhs}" is already bound to ${def.title}`,
        keymapId: def.id,
      })
    }
  })

  return diagnostics
}

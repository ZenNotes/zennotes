export type VimMode = 'normal' | 'visual' | 'insert'

export type VimMapCmd =
  | 'noremap' | 'map'
  | 'nnoremap' | 'nmap'
  | 'vnoremap' | 'vmap'
  | 'xnoremap' | 'xmap'
  | 'inoremap' | 'imap'

export type VimUnmapCmd = 'unmap' | 'nunmap' | 'vunmap' | 'xunmap' | 'iunmap'

export type AppliedVimMapping = { lhs: string; mode: VimMode }

export const VIM_MAP_CMD_MODES: Record<VimMapCmd, VimMode> = {
  noremap: 'normal',  map: 'normal',
  nnoremap: 'normal', nmap: 'normal',
  vnoremap: 'visual', vmap: 'visual',
  xnoremap: 'visual', xmap: 'visual',
  inoremap: 'insert', imap: 'insert',
}

export const VIM_UNMAP_CMD_MODES: Record<VimUnmapCmd, VimMode> = {
  unmap: 'normal',  nunmap: 'normal',
  vunmap: 'visual', xunmap: 'visual',
  iunmap: 'insert',
}

export const VIM_NOREMAP_CMDS = new Set<VimMapCmd>([
  'noremap', 'nnoremap', 'vnoremap', 'xnoremap', 'inoremap',
])

export const VIM_UNMAP_CMDS = new Set<VimUnmapCmd>([
  'unmap', 'nunmap', 'vunmap', 'xunmap', 'iunmap',
])

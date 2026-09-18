import type { Plugin } from 'vite'

export interface ZenNotesAssetsOptions {
  /** Disable the grammar checker and its binary for hosts using native spelling. */
  harper?: boolean
  /** Serve drawing fonts locally when the host supports Excalidraw. */
  excalidraw?: boolean
}

/** Build integrations for the shared editor's lazy assets. */
export function zenNotesAssets(options?: ZenNotesAssetsOptions): Plugin[]

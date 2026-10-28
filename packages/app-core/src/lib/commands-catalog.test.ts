// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_CATALOG } from '@shared/commands-catalog'
import { KEYMAP_CATALOG } from '@shared/keymaps-catalog'

// COMMAND_CATALOG (shared-domain) is a slim mirror of the commands a key can be
// bound to, used by the config writer to list them under [keymaps.commands]
// and to read a command id written straight under [keymaps]. buildCommands()
// is the source of truth: this test fails when the catalog drifts (a command
// added, removed, renamed or recategorized). To regenerate, run it with
// ZN_PRINT_COMMAND_CATALOG=1 and paste the printed array.

/** Ids the palette makes at runtime, one per thing in the vault. */
const RUNTIME_ID = /^(tasks\.savedFilter\.|workflow\.run\.|app\.workspace\.remote\.profile\.|app\.agentEdits\.review:)/

function installZen(): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      // Every host capability on, so commands a host leaves out still list:
      // a binding is portable and must mean the same thing everywhere.
      getAppInfo: vi.fn().mockReturnValue({ runtime: 'desktop' }),
      getCapabilities: vi.fn().mockReturnValue({
        supportsUpdater: true,
        supportsNativeMenus: true,
        supportsFloatingWindows: true,
        supportsLocalFilesystemPickers: true,
        supportsRemoteWorkspace: true,
        supportsCliInstall: true,
        supportsCustomTemplates: true,
        supportsWorkflows: true,
        supportsCloudSync: true
      }),
      platformSync: () => 'darwin',
      applyWorkflow: vi.fn(),
      closeVault: vi.fn(),
      openVaultWindow: vi.fn()
    }
  })
}

async function generatedCatalog(): Promise<
  Array<{ id: string; title: string; category: string; keywords?: string }>
> {
  vi.resetModules()
  localStorage.clear()
  const { useStore } = await import('../store')
  const { buildCommands } = await import('./commands')
  useStore.setState({ workflowsEnabled: true, workspaceMode: 'local' })
  return buildCommands({ includeUnavailable: true })
    .filter((command) => !RUNTIME_ID.test(command.id))
    .map((command) => ({
      id: command.id,
      title: command.bindTitle ?? command.title,
      category: command.category,
      ...(command.keywords ? { keywords: command.keywords } : {})
    }))
}

beforeEach(() => {
  vi.restoreAllMocks()
  installZen()
})

describe('COMMAND_CATALOG', () => {
  it('mirrors every command with a fixed id, in palette order', async () => {
    const generated = await generatedCatalog()
    if (process.env.ZN_PRINT_COMMAND_CATALOG) {
      const q = (value: string): string => JSON.stringify(value)
      const lines = generated.map(
        (entry) =>
          `  { id: ${q(entry.id)}, title: ${q(entry.title)}, category: ${q(entry.category)}${
            entry.keywords ? `, keywords: ${q(entry.keywords)}` : ''
          } }`
      )
      console.log(`export const COMMAND_CATALOG: CommandCatalogEntry[] = [\n${lines.join(',\n')}\n]`)
    }
    expect(COMMAND_CATALOG).toEqual(generated)
  })

  it('has no duplicate ids', () => {
    const ids = COMMAND_CATALOG.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('shares ids with the keymap catalog only where the two mean different things', () => {
    // `nav.back` is both the `h` back-out action and the Go Back command,
    // the collision that gave command bindings their own namespace. Any new
    // shared id has to be looked at the same way before it ships.
    const actionIds = new Set(KEYMAP_CATALOG.map((entry) => entry.id))
    expect(COMMAND_CATALOG.filter((entry) => actionIds.has(entry.id)).map((e) => e.id)).toEqual([
      'nav.back'
    ])
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { createPortableBridge } from './portable-bridge'
import { installTestHost } from '../test/test-host'

// The iPhone left supportsTemplateFolder out and Android said true. app-core
// shows the setting unless a host says false, so both behaved alike; the
// package says it outright, because the vault keeps the folder through a save
// (template-folder.test.ts) and a host that ever cannot must say false.
describe('the portable bridge\'s capabilities', () => {
  it('keeps vault.json\'s template folder', () => {
    const bridge = createPortableBridge(installTestHost())
    assert.equal(bridge.getCapabilities().supportsTemplateFolder, true)
  })

  it('takes the phones\' shared defaults', () => {
    const capabilities = createPortableBridge(installTestHost()).getCapabilities()
    assert.equal(capabilities.supportsCloudSync, true)
    assert.equal(capabilities.supportsRemoteWorkspace, true)
    assert.equal(capabilities.supportsLocalFilesystemPickers, true)
    assert.equal(capabilities.supportsCustomTemplates, true)
    assert.equal(capabilities.supportsCustomCodeLanguages, false)
    assert.equal(capabilities.supportsUpdater, false)
  })

  it('lets the host turn one off', () => {
    const bridge = createPortableBridge(installTestHost({ shell: { capabilities: { supportsLocalFilesystemPickers: false } } }))
    assert.equal(bridge.getCapabilities().supportsLocalFilesystemPickers, false)
    assert.equal(bridge.getCapabilities().supportsTemplateFolder, true)
  })
})

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'vitest'
import { createPortableBridge } from './portable-bridge'
import { installTestHost, type TestHost } from '../test/test-host'

// The version is the host's to read, from its native bundle, during boot:
// the iPhone's Info.plist, Android's versionName. Android wrote it down in
// the bridge ('1.1.57', bumped by hand each release) and built the update
// and Raycast states once at module load, so even a native lookup could
// never reach them; the iPhone builds them per call. The package has no
// version of its own and reads the host's on every call.
describe('what the bridge says about the app', () => {
  let host: TestHost

  beforeEach(() => {
    host = installTestHost()
  })

  it('reports the host\'s version as it changes during boot', async () => {
    const bridge = createPortableBridge(host)
    assert.equal(bridge.getAppInfo().version, '9.9.9-test')
    host.shell.version = '1.38.0'
    assert.equal(bridge.getAppInfo().version, '1.38.0')
    assert.equal((await bridge.getAppUpdateState()).currentVersion, '1.38.0')
    assert.equal((await bridge.checkForAppUpdates()).currentVersion, '1.38.0')
    assert.equal((await bridge.raycastGetStatus()).bundledVersion, '1.38.0')
  })

  // Android's said "Updates are delivered through the App Store."
  it('says how this host delivers updates', async () => {
    const bridge = createPortableBridge(installTestHost({ shell: { updatesMessage: 'Updates are delivered through Google Play.' } }))
    const state = await bridge.getAppUpdateState()
    assert.equal(state.phase, 'unsupported')
    assert.equal(state.message, 'Updates are delivered through Google Play.')
  })

  it('names the host in a desktop-only refusal', async () => {
    const bridge = createPortableBridge(installTestHost({ shell: { unavailableWhere: 'in the mobile app' } }))
    await assert.rejects(Promise.resolve().then(() => bridge.readExternalFile()), /zen\.readExternalFile is not available in the mobile app/)
  })

  it('reports the host\'s platform and fonts', async () => {
    const bridge = createPortableBridge(installTestHost({
      shell: { platform: 'android', listSystemFonts: async () => ['Roboto', 'Noto Serif'] }
    }))
    assert.equal(await bridge.platform(), 'android')
    assert.equal(bridge.platformSync(), 'android')
    assert.deepEqual(await bridge.listSystemFonts(), ['Roboto', 'Noto Serif'])
  })
})

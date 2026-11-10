/**
 * A PortableHost for tests: every piece in memory, every call recorded, and
 * each piece replaceable. `installTestHost()` installs a fresh one and
 * returns it; pass overrides for the parts a test drives (an HTTP responder,
 * a vault tier).
 */
import type { ZenAppInfo } from '@zennotes/bridge-contract/bridge'
import {
  installPortableHost,
  type AppLifecycle,
  type HostShell,
  type HostStorage,
  type HostVaults,
  type HttpTransport,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type PortableHost,
  type SecretStorage
} from '../src/host'

export class MemoryStorage implements HostStorage {
  readonly values = new Map<string, string>()
  private failures = new Map<string, unknown>()

  /** The next read of `key` throws, as a store that is not answering would. */
  failRead(key: string, error: unknown = new Error(`read of ${key} failed`)): void {
    this.failures.set(key, error)
  }

  async read(key: string): Promise<string | null> {
    const failure = this.failures.get(key)
    if (failure !== undefined) {
      this.failures.delete(key)
      throw failure
    }
    return this.values.get(key) ?? null
  }

  async write(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key)
  }

  json(key: string): unknown {
    const value = this.values.get(key)
    return value === undefined ? undefined : JSON.parse(value)
  }
}

export class MemorySecrets implements SecretStorage {
  readonly values = new Map<string, string>()
  prepared = 0
  constructor(public isAvailable = true) {}
  available(): boolean {
    return this.isAvailable
  }
  async prepare(): Promise<void> {
    this.prepared += 1
  }
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    if (!this.isAvailable) throw new Error('No secure storage here.')
    this.values.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.values.delete(key)
  }
  async keys(): Promise<string[]> {
    return [...this.values.keys()]
  }
}

export type HttpResponder = (request: HttpTransportRequest) => HttpTransportResponse | Promise<HttpTransportResponse>

export class RecordingHttp implements HttpTransport {
  readonly requests: HttpTransportRequest[] = []
  readonly uploads: Parameters<NonNullable<HttpTransport['putFile']>>[0][] = []
  constructor(
    public responder: HttpResponder = () => ({ status: 200, headers: {}, data: {} }),
    public fileResponder: ((options: Parameters<NonNullable<HttpTransport['putFile']>>[0]) => Promise<{ status: number }>) | null = null
  ) {}

  async request(options: HttpTransportRequest): Promise<HttpTransportResponse> {
    this.requests.push(options)
    return await this.responder(options)
  }

  putFile = async (options: Parameters<NonNullable<HttpTransport['putFile']>>[0]): Promise<{ status: number }> => {
    this.uploads.push(options)
    if (!this.fileResponder) return { status: 200 }
    return await this.fileResponder(options)
  }
}

export interface TestShell extends HostShell {
  downloads: Parameters<HostShell['saveDownload']>[0][]
  clipboard: string[]
  version: string
}

export interface TestLifecycle extends AppLifecycle {
  activeListeners: Array<(active: boolean) => void>
  urlListeners: Array<(url: string) => void>
  launch: string | null
  left: number
  returned: number
}

export function testLifecycle(overrides: Partial<AppLifecycle> = {}): TestLifecycle {
  const lifecycle: TestLifecycle = {
    activeListeners: [],
    urlListeners: [],
    launch: null,
    left: 0,
    returned: 0,
    async onOpenUrl(listener) {
      lifecycle.urlListeners.push(listener)
    },
    async launchUrl() {
      return lifecycle.launch
    },
    async onActiveChange(listener) {
      lifecycle.activeListeners.push(listener)
    },
    leftApp() {
      lifecycle.left += 1
    },
    returnedToApp() {
      lifecycle.returned += 1
    },
    ...overrides
  }
  return lifecycle
}

export function testShell(overrides: Partial<HostShell> = {}): TestShell {
  const shell: TestShell = {
    downloads: [],
    clipboard: [],
    version: '9.9.9-test',
    appInfo(): ZenAppInfo {
      return {
        name: 'zennotes-test',
        productName: 'ZenNotes',
        version: shell.version,
        description: 'ZenNotes test host',
        runtime: 'web',
        hostKind: 'ios'
      }
    },
    platform: 'darwin',
    async listSystemFonts() {
      return ['Georgia']
    },
    updatesMessage: 'Updates are delivered through the test store.',
    unavailableWhere: 'in the test host',
    drawingsViewOnly: () => false,
    async writeClipboard(text) {
      shell.clipboard.push(text)
    },
    async saveDownload(options) {
      shell.downloads.push(options)
    },
    cloud: { platform: 'ios', deviceName: 'ZenNotes Test', allowInsecureLoopback: false },
    ...overrides
  }
  return shell
}

function unsupported(name: string): never {
  throw new Error(`The test host has no ${name}.`)
}

export function testVaults(overrides: Partial<HostVaults> = {}): HostVaults {
  return {
    openDefault: async () => unsupported('openDefault'),
    list: async () => [],
    open: async () => unsupported('open'),
    pick: async () => null,
    select: async () => unsupported('select'),
    browse: async (path) => ({ currentPath: path, parentPath: null, entries: [], shortcuts: [] }),
    describeRoot: (vault) => `Test › ${vault.name}`,
    openAssetExternally: async () => ({ ok: false, error: 'desktop-only' }),
    ...overrides
  }
}

export interface TestHost extends PortableHost {
  shell: TestShell
  lifecycle: TestLifecycle
  http: RecordingHttp
  storage: MemoryStorage
  preferences: MemoryStorage
  secrets: MemorySecrets
}

export function createTestHost(overrides: {
  shell?: Partial<HostShell>
  lifecycle?: Partial<AppLifecycle>
  http?: RecordingHttp
  storage?: MemoryStorage
  preferences?: MemoryStorage
  secrets?: MemorySecrets
  vaults?: Partial<HostVaults>
} = {}): TestHost {
  return {
    shell: testShell(overrides.shell),
    lifecycle: testLifecycle(overrides.lifecycle),
    http: overrides.http ?? new RecordingHttp(),
    storage: overrides.storage ?? new MemoryStorage(),
    preferences: overrides.preferences ?? new MemoryStorage(),
    secrets: overrides.secrets ?? new MemorySecrets(),
    vaults: testVaults(overrides.vaults)
  }
}

export function installTestHost(overrides: Parameters<typeof createTestHost>[0] = {}): TestHost {
  const host = createTestHost(overrides)
  installPortableHost(host)
  return host
}

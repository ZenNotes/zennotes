import { describe, expect, it } from 'vitest'
import { CloudSyncApiClient, type CloudSyncHttpRequest } from './cloud-sync-api'

describe('CloudSyncApiClient', () => {
  it('builds versioned manifest and change requests without platform-specific code', async () => {
    const requests: CloudSyncHttpRequest[] = []
    const client = new CloudSyncApiClient({
      async request<Response>(request: CloudSyncHttpRequest): Promise<Response> {
        requests.push(request)
        return {} as Response
      }
    })

    await client.manifest('vault/one', { includeContent: true, page: 2, perPage: 50 })
    await client.changes('vault/one', 41, 25)
    await client.account()

    expect(requests).toEqual([
      {
        method: 'GET',
        path: '/api/v1/vaults/vault%2Fone/manifest?include_content=true&page=2&per_page=50'
      },
      {
        method: 'GET',
        path: '/api/v1/vaults/vault%2Fone/changes?after=41&limit=25'
      },
      {
        method: 'GET',
        path: '/api/v1/account'
      }
    ])
  })

  it('sends mutations and backup labels in JSON bodies', async () => {
    const requests: CloudSyncHttpRequest[] = []
    const client = new CloudSyncApiClient({
      async request<Response>(request: CloudSyncHttpRequest): Promise<Response> {
        requests.push(request)
        return {} as Response
      }
    })

    await client.mutate('vault-1', { mutations: [] })
    await client.createBackup('vault-1', 'Before migration')

    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/api/v1/vaults/vault-1/mutations',
        body: { mutations: [] }
      },
      {
        method: 'POST',
        path: '/api/v1/vaults/vault-1/backups',
        body: { label: 'Before migration' }
      }
    ])
  })

  it('initiates, completes, and aborts direct sync uploads', async () => {
    const requests: CloudSyncHttpRequest[] = []
    const client = new CloudSyncApiClient({
      async request<Response>(request: CloudSyncHttpRequest): Promise<Response> {
        requests.push(request)
        return {} as Response
      }
    })
    const upload = {
      operation_id: '4b66f4b4-08f9-4e5a-a300-686ed4ef7e92',
      item_id: '9b0ff39e-7ace-4fae-82aa-9f80a7458543',
      base_revision: 2,
      path: 'attachments/archive.zip',
      kind: 'binary' as const,
      content: {
        encoding: 'base64' as const,
        sha256: 'a'.repeat(64),
        byte_length: 6_000_000,
        media_type: 'application/zip'
      }
    }

    await client.initiateUpload('vault/1', upload)
    await client.completeUpload('vault/1', 'upload/1')
    await client.abortUpload('vault/1', 'upload/1')

    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/api/v1/vaults/vault%2F1/uploads',
        body: upload
      },
      {
        method: 'POST',
        path: '/api/v1/vaults/vault%2F1/uploads/upload%2F1/complete',
        timeoutMs: 300_000
      },
      {
        method: 'DELETE',
        path: '/api/v1/vaults/vault%2F1/uploads/upload%2F1'
      }
    ])
  })

  it('addresses backup deletion, download, and idempotent restores', async () => {
    const requests: CloudSyncHttpRequest[] = []
    const client = new CloudSyncApiClient({
      async request<Response>(request: CloudSyncHttpRequest): Promise<Response> {
        requests.push(request)
        return {} as Response
      }
    })

    await client.deleteBackup('vault/1', 'backup/1')
    await client.createBackupRestore('vault/1', 'backup/1', {
      idempotency_key: '4b66f4b4-08f9-4e5a-a300-686ed4ef7e92',
      expected_cursor: 42
    })
    await client.backupRestore('vault/1', 'backup/1', 'restore/1')

    expect(requests).toEqual([
      {
        method: 'DELETE',
        path: '/api/v1/vaults/vault%2F1/backups/backup%2F1'
      },
      {
        method: 'POST',
        path: '/api/v1/vaults/vault%2F1/backups/backup%2F1/restores',
        body: {
          idempotency_key: '4b66f4b4-08f9-4e5a-a300-686ed4ef7e92',
          expected_cursor: 42
        }
      },
      {
        method: 'GET',
        path: '/api/v1/vaults/vault%2F1/backups/backup%2F1/restores/restore%2F1'
      }
    ])
    expect(client.backupDownloadPath('vault/1', 'backup/1')).toBe(
      '/api/v1/vaults/vault%2F1/backups/backup%2F1/download'
    )
  })

  it('permanently deletes an encoded cloud vault', async () => {
    const requests: CloudSyncHttpRequest[] = []
    const client = new CloudSyncApiClient({
      async request<Response>(request: CloudSyncHttpRequest): Promise<Response> {
        requests.push(request)
        return {} as Response
      }
    })

    await client.deleteVault('vault/1')

    expect(requests).toEqual([
      {
        method: 'DELETE',
        path: '/api/v1/vaults/vault%2F1'
      }
    ])
  })

  it('addresses backup schedules, snapshot items, and one-note restores', async () => {
    const requests: CloudSyncHttpRequest[] = []
    const client = new CloudSyncApiClient({
      async request<Response>(request: CloudSyncHttpRequest): Promise<Response> {
        requests.push(request)
        return {} as Response
      }
    })

    await client.backupSchedule('vault/1')
    await client.updateBackupSchedule('vault/1', true)
    await client.listBackupItems('vault/1', 'backup/1')
    await client.restoreBackupNote('vault/1', 'backup/1', 42, {
      idempotency_key: '4b66f4b4-08f9-4e5a-a300-686ed4ef7e92',
      expected_cursor: 12
    })

    expect(requests).toEqual([
      {
        method: 'GET',
        path: '/api/v1/vaults/vault%2F1/backup-schedule'
      },
      {
        method: 'PUT',
        path: '/api/v1/vaults/vault%2F1/backup-schedule',
        body: { enabled: true }
      },
      {
        method: 'GET',
        path: '/api/v1/vaults/vault%2F1/backups/backup%2F1/items'
      },
      {
        method: 'POST',
        path: '/api/v1/vaults/vault%2F1/backups/backup%2F1/items/42/restore',
        body: {
          idempotency_key: '4b66f4b4-08f9-4e5a-a300-686ed4ef7e92',
          expected_cursor: 12
        }
      }
    ])
  })

  it('lists, publishes, updates, and unpublishes notes', async () => {
    const requests: CloudSyncHttpRequest[] = []
    const client = new CloudSyncApiClient({
      async request<Response>(request: CloudSyncHttpRequest): Promise<Response> {
        requests.push(request)
        return {} as Response
      }
    })
    const input = {
      note_path: 'inbox/Launch.md',
      title: 'Launch',
      markdown: '# Launch'
    }

    await client.listPublishedNotes()
    await client.publishNote(input)
    await client.updatePublishedNote(42, input)
    await client.unpublishNote(42)

    const payload = JSON.stringify({ ...input, tikz_svgs: [], asset_refs: [] })
    expect(requests).toEqual([
      { method: 'GET', path: '/api/v1/shares' },
      { method: 'POST', path: '/api/v1/shares', body: { payload } },
      { method: 'PUT', path: '/api/v1/shares/42', body: { payload } },
      { method: 'DELETE', path: '/api/v1/shares/42' }
    ])
  })

  it('sends published-note assets as multipart form data', async () => {
    const requests: CloudSyncHttpRequest[] = []
    const client = new CloudSyncApiClient({
      async request<Response>(request: CloudSyncHttpRequest): Promise<Response> {
        requests.push(request)
        return {} as Response
      }
    })

    await client.publishNote({
      note_path: 'inbox/Photo.md',
      title: 'Photo',
      markdown: '![Photo](photo.png)',
      assets: [{
        ref: 'photo.png',
        name: 'photo.png',
        mime: 'image/png',
        base64: 'AQID'
      }]
    })

    const form = requests[0]?.body
    expect(form).toBeInstanceOf(FormData)
    expect(JSON.parse(String((form as FormData).get('payload')))).toEqual({
      note_path: 'inbox/Photo.md',
      title: 'Photo',
      markdown: '![Photo](photo.png)',
      tikz_svgs: [],
      asset_refs: ['photo.png']
    })
    const asset = (form as FormData).get('assets[]')
    expect(asset).toBeInstanceOf(File)
    expect((asset as File).name).toBe('photo.png')
    expect([...new Uint8Array(await (asset as File).arrayBuffer())]).toEqual([1, 2, 3])
  })

  it('serializes published appearance and a replacement logo', async () => {
    const requests: CloudSyncHttpRequest[] = []
    const client = new CloudSyncApiClient({
      async request<Response>(request: CloudSyncHttpRequest): Promise<Response> {
        requests.push(request)
        return {} as Response
      }
    })

    await client.publishNote({
      note_path: 'inbox/Styled.md',
      title: 'Styled',
      markdown: '# Styled',
      appearance: {
        theme: 'rose-pine-moon',
        logo: {
          ref: 'brand-logo',
          name: 'brand.png',
          mime: 'image/png',
          base64: 'AQID'
        }
      }
    })

    const form = requests[0]?.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(JSON.parse(String(form.get('payload')))).toEqual({
      note_path: 'inbox/Styled.md',
      title: 'Styled',
      markdown: '# Styled',
      appearance: { theme: 'rose-pine-moon', logo_action: 'replace' },
      tikz_svgs: [],
      asset_refs: []
    })
    const logo = form.get('brand_logo') as File
    expect(logo.name).toBe('brand.png')
    expect([...new Uint8Array(await logo.arrayBuffer())]).toEqual([1, 2, 3])
  })

  it('can remove a published logo without multipart data', async () => {
    const requests: CloudSyncHttpRequest[] = []
    const client = new CloudSyncApiClient({
      async request<Response>(request: CloudSyncHttpRequest): Promise<Response> {
        requests.push(request)
        return {} as Response
      }
    })

    await client.updatePublishedNote(42, {
      note_path: 'inbox/Styled.md',
      title: 'Styled',
      markdown: '# Styled',
      appearance: { theme: 'system', logo: null }
    })

    expect(requests[0]?.body).toEqual({
      payload: JSON.stringify({
        note_path: 'inbox/Styled.md',
        title: 'Styled',
        markdown: '# Styled',
        appearance: { theme: 'system', logo_action: 'remove' },
        tikz_svgs: [],
        asset_refs: []
      })
    })
  })
})

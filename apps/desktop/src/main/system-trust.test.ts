import { describe, expect, it, vi } from 'vitest'
import { addSystemCertificates, type CertificateStore } from './system-trust'

function store(defaults: string[], system: string[] | Error): CertificateStore & {
  set: ReturnType<typeof vi.fn>
} {
  const set = vi.fn()
  return {
    getCACertificates: (type) => {
      if (type === 'default') return defaults
      if (system instanceof Error) throw system
      return system
    },
    setDefaultCACertificates: set,
    set
  }
}

describe('addSystemCertificates (#1009)', () => {
  it("adds the system's certificates to Node's own, once each", () => {
    const certificates = store(['node-a', 'node-b'], ['node-b', 'private-ca'])
    expect(addSystemCertificates(certificates)).toBe(true)
    expect(certificates.set).toHaveBeenCalledWith(['node-a', 'node-b', 'private-ca'])
  })

  it('leaves the default list alone when the system store is empty', () => {
    const certificates = store(['node-a'], [])
    expect(addSystemCertificates(certificates)).toBe(false)
    expect(certificates.set).not.toHaveBeenCalled()
  })

  it("keeps Node's list when the system store cannot be read", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const certificates = store(['node-a'], new Error('keychain locked'))
    expect(addSystemCertificates(certificates)).toBe(false)
    expect(certificates.set).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('does nothing on a Node without the calls', () => {
    expect(addSystemCertificates({} as CertificateStore)).toBe(false)
  })
})

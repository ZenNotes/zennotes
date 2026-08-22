import { describe, expect, it } from 'vitest'
import { canManageWorkflows } from './workflow-workspace'

describe('canManageWorkflows', () => {
  it('enables workflows in web workspaces backed by a capable server', () => {
    expect(canManageWorkflows('web', 'local', { supportsWorkflows: true })).toBe(true)
  })

  it('keeps older servers read-only in web and remote desktop workspaces', () => {
    expect(canManageWorkflows('web', 'local', {})).toBe(false)
    expect(canManageWorkflows('desktop', 'remote', {})).toBe(false)
  })

  it('enables remote desktop workspaces when the server supports workflows', () => {
    expect(canManageWorkflows('desktop', 'remote', { supportsWorkflows: true })).toBe(true)
  })

  it('retains local desktop workflow support', () => {
    expect(canManageWorkflows('desktop', 'local', {})).toBe(true)
  })
})

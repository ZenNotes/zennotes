import type { ZenAppInfo } from '@bridge-contract/bridge'

/**
 * The lines `:version` prints and Settings > About shows (#814). One place
 * builds them so a bug report pasted from either surface reads the same.
 * A field the host did not fill in is left out rather than shown as
 * "unknown": the host (desktop preload, web bridge, mobile shell) is the one
 * that knows what it can answer. Pure, so the shape is testable without a
 * window.
 */
export interface VersionReportInput {
  app: ZenAppInfo
  /** The `remote` workspace a desktop window is connected to, if any. */
  remoteServer?: { baseUrl: string | null; version: string | null } | null
}

export function buildVersionReport(input: VersionReportInput): string[] {
  const { app } = input
  const host = app.hostKind ?? (app.runtime === 'desktop' ? 'desktop' : 'browser')
  const lines = [`${app.productName ?? 'ZenNotes'} ${app.version} (${host})`]
  const os = [app.os, app.arch].filter((part): part is string => Boolean(part)).join(', ')
  if (os) lines.push(`OS: ${os}`)
  if (app.engine) lines.push(`Engine: ${app.engine}`)
  if (app.install) lines.push(`Install: ${app.install}`)
  if (input.remoteServer) {
    const server = input.remoteServer.version ? `server ${input.remoteServer.version}` : 'server'
    const at = input.remoteServer.baseUrl ? ` at ${input.remoteServer.baseUrl}` : ''
    lines.push(`Workspace: remote, ${server}${at}`)
  }
  return lines
}

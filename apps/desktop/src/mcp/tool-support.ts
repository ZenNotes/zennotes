/** What every MCP tool definition shares: its shape and how it reads arguments. */

import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { VaultBackend } from '../cli/backend.js'
import type { VaultTarget } from '../cli/vault-target.js'
import type { NoteFolder } from './vault-ops.js'

export interface ToolContext {
  /** Set on the vault_info call that moved the session to a new vault: the
   *  vault it left. */
  previous?: VaultTarget | null
}

export interface ToolDef {
  schema: Tool
  handler: (
    args: Record<string, unknown>,
    backend: VaultBackend,
    context?: ToolContext
  ) => Promise<unknown>
}

type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } }

/** A tool's answer in more than text (read_asset), sent as it is. */
export class RawToolResult {
  constructor(readonly content: ToolContent[]) {}
}

/**
 * Arguments as they will be stored. JSON can carry half a surrogate pair, which a
 * file name turns into U+FFFD on the way to disk, while `encodeURIComponent` refuses
 * it outright: the note was written and the answer, which links to it, was
 * `URI malformed`. A client that retried then made a second note.
 */
export function wellFormedArguments<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/\p{Cs}/gu, '\ufffd') as T
  if (Array.isArray(value)) return value.map(wellFormedArguments) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        wellFormedArguments(key),
        wellFormedArguments(item)
      ])
    ) as T
  }
  return value
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required string argument: ${key}`)
  }
  return value
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value == null) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

export function requireFolder(args: Record<string, unknown>, key: string): NoteFolder {
  const value = requireString(args, key)
  if (value !== 'inbox' && value !== 'quick' && value !== 'archive' && value !== 'trash') {
    throw new Error(`${key} must be one of inbox, quick, archive, trash`)
  }
  return value
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  if (value == null) return undefined
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  return value
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number`)
  }
  return value
}

export function optionalStringArray(
  args: Record<string, unknown>,
  key: string
): string[] | undefined {
  const value = args[key]
  if (value == null) return undefined
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(`${key} must be an array of strings`)
  }
  return value as string[]
}

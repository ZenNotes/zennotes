/**
 * Attachments (ZenNotes/tui#34). Every tool finds its file in the vault's asset
 * listing, whatever the scope: the listing leaves out notes, hidden and internal
 * files, database folders and links to files, so nothing else can be named
 * through these tools. Deleting is the soft delete
 * the app's Trash can undo. Purging is left out on purpose: it cannot be undone,
 * an assistant never needs it to finish a task, and the user can do it in the
 * app. The Go `zn mcp` has the same tools in internal/mcp/assets.go, with the
 * same names, schemas, results and errors.
 */

import path from 'node:path'
import {
  DATABASE_SIDECAR_SUFFIX,
  FORM_DIR_SUFFIX,
  formDirContaining,
  isDatabaseSidecarPath
} from '@shared/databases'
import { isExcalidrawPath } from '@shared/excalidraw'
import { isInsideMcpScopeEntryFolded } from '@shared/mcp-scope'
import { resolveFolderPath } from '@shared/system-folder-paths'
import { isAtomicWriteTempPath } from '../main/atomic-write.js'
import type { VaultAssetMeta, VaultBackend } from '../cli/backend.js'
import {
  assetNotFound,
  cleanRequest,
  deletedAssetNotFound,
  matchAsset,
  ScopedBackend
} from './scoped-backend.js'
import { optionalBoolean, RawToolResult, requireString, type ToolDef } from './tool-support.js'
import { importedAssetFilename } from './vault-ops.js'

/** A tool call carries the file as base64 inside one JSON-RPC message, held in
 *  memory several times over. */
const MAX_UPLOAD_ASSET_BYTES = 16 * 1024 * 1024
/** Past this a client's context limits refuse the result anyway. */
const MAX_READ_ASSET_BYTES = 5 * 1024 * 1024
const MIB = 1024 * 1024

async function findAsset(backend: VaultBackend, raw: string): Promise<{ meta: VaultAssetMeta }> {
  const meta = matchAsset(await backend.listAssets(), raw)
  if (!meta) throw assetNotFound(raw)
  return { meta }
}

/** Keeps these tools off a loose CSV database and its schema file: they move as
 *  a pair, which only the database code knows how to do. */
async function refuseDatabaseFile(meta: VaultAssetMeta, backend: VaultBackend): Promise<void> {
  const refusal = new Error('That file belongs to a ZenNotes database. Change it from the app.')
  if (isDatabaseSidecarPath(meta.path)) throw refusal
  if (!meta.path.toLowerCase().endsWith('.csv') || formDirContaining(meta.path)) return
  // The whole listing: a pair stays a pair when a scope hides half of it.
  const listing = backend instanceof ScopedBackend ? backend.inner : backend
  const all = await listing.listAssets()
  if (all.some((asset) => asset.path === meta.path + DATABASE_SIDECAR_SUFFIX)) throw refusal
}

/** What a loose CSV keeps beside it that is not the user's: its schema file and
 *  the backups of either. The app's Assets view leaves these out. Other tools can
 *  still tell a database by them. */
function isLooseCsvInternal(rel: string): boolean {
  const lower = rel.toLowerCase()
  return (
    isDatabaseSidecarPath(lower) ||
    lower.endsWith('.csv.bak') ||
    lower.endsWith(`.csv${DATABASE_SIDECAR_SUFFIX}.bak`)
  )
}

/** Device names Windows keeps, with or without an extension. */
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]) *(?:\.|$)/i

/** Refuses a name the asset listing would not show afterwards, since a file the
 *  listing cannot see is one no tool can reach again. */
function checkAssetName(name: string): void {
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') throw new Error('A file name is required.')
  if (/[/\\\u0000]/.test(trimmed)) throw new Error('Use only a file name, with no folder in it.')
  if (trimmed.startsWith('.')) throw new Error('A file name cannot start with a dot.')
  // However it is dressed up, a note's name is a note's.
  if (trimmed.split(':')[0].replace(/[. ]+$/, '').toLowerCase().endsWith('.md')) {
    throw new Error('Notes are not attachments: use create_note or rename_note.')
  }
  if (WINDOWS_RESERVED_NAME.test(trimmed)) {
    throw new Error('That name is reserved on Windows, so choose another.')
  }
  if (isExcalidrawPath(trimmed) || isAtomicWriteTempPath(trimmed) || isDatabaseSidecarPath(trimmed)) {
    throw new Error('That kind of file cannot be managed as an attachment.')
  }
}

/** What upload_asset cleans out of a name, refused for a rename. These break every
 *  link to the file, or do not survive on another system, and the rename would
 *  still report success. */
// eslint-disable-next-line no-control-regex
const NAME_BREAKS_LINKS = /[#?|[\]^%:*"<>`\u0000-\u001f\u007f]|[. ]$/

function checkAssetNewName(name: string): void {
  checkAssetName(name)
  if (NAME_BREAKS_LINKS.test(name.trim())) {
    throw new Error(
      'A file name cannot contain # ? | [ ] ^ % : * " < > ` or a control character, or end with a dot, since links to it would break.'
    )
  }
}

/** Refuses a destination whatever the scope: anything that is not a plain
 *  vault-relative folder, a database's insides, and the trash, whose contents
 *  empty_trash and the app destroy. */
async function checkAssetTargetDir(backend: VaultBackend, raw: string): Promise<string> {
  const refused = new Error('This assistant cannot put files there.')
  const clean = cleanRequest(raw)
  // The move trims what it is given, so this has to be what it will use.
  if (!clean || raw.trim() !== raw) throw refused
  // A name other systems cannot hold or read the same way.
  if (clean.split('/').some((seg) => /[. ]$|:/.test(seg))) throw refused
  if (clean.split('/').some((seg) => seg.toLowerCase().endsWith(FORM_DIR_SUFFIX))) throw refused
  const { systemFolderPaths } = await backend.vaultLayout()
  if (isInsideMcpScopeEntryFolded(clean, resolveFolderPath('trash', systemFolderPaths))) {
    throw refused
  }
  return clean
}

/** Reads what a client plausibly sends: standard or URL-safe, padded or not,
 *  wrapped lines, a data: URL. It refuses by length before it decodes. */
export function decodeAssetBase64(raw: string): Uint8Array {
  let text = raw
  if (text.startsWith('data:')) {
    const comma = text.indexOf(',')
    if (comma < 0 || !text.slice(0, comma).endsWith(';base64')) {
      throw new Error('content_base64 is a data: URL that is not base64.')
    }
    text = text.slice(comma + 1)
  }
  const tooLarge = new Error(
    `upload_asset takes files up to ${MAX_UPLOAD_ASSET_BYTES / MIB} MiB; this one is larger. Add it from the app or copy it into the vault instead.`
  )
  // Wrapped base64 has at most a little whitespace on top; this bounds the work
  // below without refusing a file that fits.
  const encodedLimit = Math.ceil(MAX_UPLOAD_ASSET_BYTES / 3) * 4
  if (text.length > encodedLimit * 2) throw tooLarge
  text = text
    .replace(/[ \t\r\n]/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  // A loop, not /=+$/, which takes quadratic time on a run of = before the end.
  let end = text.length
  while (end > 0 && text[end - 1] === '=') end -= 1
  text = text.slice(0, end)
  if (Math.floor((text.length * 6) / 8) > MAX_UPLOAD_ASSET_BYTES) throw tooLarge
  if (!/^[A-Za-z0-9+/]*$/.test(text) || text.length % 4 === 1) {
    throw new Error('content_base64 is not valid base64.')
  }
  const data = Buffer.from(text, 'base64')
  if (data.length === 0) throw new Error('content_base64 is empty.')
  return data
}

const ASSET_IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

const ASSET_AUDIO_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg'
}

const ASSET_BINARY_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm'
}

function utf8Text(data: Uint8Array): string | null {
  if (data.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data)
  } catch {
    return null
  }
}

/** Go's url.PathEscape, so a resource's URI reads the same from either engine. */
function pathEscape(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%(24|26|2B|3D|3A|40)/g, (escaped) => decodeURIComponent(escaped))
}

/** A read_asset answer: a line of facts, then the file as the MCP content type a
 *  client can use. A model sees an image, reads text as text, and anything else
 *  arrives as an embedded resource. */
function assetResult(meta: VaultAssetMeta, data: Uint8Array): RawToolResult {
  const ext = path.posix.extname(meta.name).toLowerCase()
  const base64 = (): string => Buffer.from(data).toString('base64')
  const text = ASSET_BINARY_TYPES[ext] ? null : utf8Text(data)
  let mimeType: string
  let content: ConstructorParameters<typeof RawToolResult>[0][number]
  if (ASSET_IMAGE_TYPES[ext]) {
    mimeType = ASSET_IMAGE_TYPES[ext]
    content = { type: 'image', data: base64(), mimeType }
  } else if (ASSET_AUDIO_TYPES[ext]) {
    mimeType = ASSET_AUDIO_TYPES[ext]
    content = { type: 'audio', data: base64(), mimeType }
  } else if (text !== null) {
    mimeType = 'text/plain'
    content = { type: 'text', text }
  } else {
    mimeType = ASSET_BINARY_TYPES[ext] ?? 'application/octet-stream'
    content = {
      type: 'resource',
      resource: { uri: `zennotes://asset/${pathEscape(meta.path)}`, mimeType, blob: base64() }
    }
  }
  const facts = JSON.stringify(
    { path: meta.path, name: meta.name, size: meta.size, mimeType },
    null,
    2
  )
  return new RawToolResult([{ type: 'text', text: facts }, content])
}

const tooLargeToRead = (name: string, size: number): Error =>
  new Error(
    `${name} is ${(size / MIB).toFixed(1)} MiB; read_asset returns files up to ${MAX_READ_ASSET_BYTES / MIB} MiB.`
  )

const PATH_ONLY_SCHEMA = {
  type: 'object' as const,
  properties: { path: { type: 'string' } },
  required: ['path']
}

export const ASSET_TOOLS: ToolDef[] = [
  {
    schema: {
      name: 'read_asset',
      description:
        'Read an attachment from list_assets: an image comes back as an image you can see, text as text, anything else (PDF, audio, video) as an embedded file. Files up to 5 MiB.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative path exactly as list_assets returned it.'
          }
        },
        required: ['path']
      }
    },
    handler: async (args, backend) => {
      const { meta } = await findAsset(backend, requireString(args, 'path'))
      if (meta.size > MAX_READ_ASSET_BYTES) throw tooLargeToRead(meta.name, meta.size)
      const data = await backend.readAsset(meta.path)
      if (data.length > MAX_READ_ASSET_BYTES) throw tooLargeToRead(meta.name, data.length)
      return assetResult(meta, data)
    }
  },
  {
    schema: {
      name: 'upload_asset',
      description:
        "Add a file to the vault's assets folder from base64 (up to 16 MiB), never overwriting: a taken name gets a number. Returns its `path` and `markdown`, the embed or link to paste into a note with append_to_note or edit_section.",
      inputSchema: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'File name with its extension, such as plot.png.'
          },
          content_base64: { type: 'string', description: "The file's bytes as base64." }
        },
        required: ['filename', 'content_base64']
      }
    },
    handler: async (args, backend) => {
      const name = requireString(args, 'filename')
      const encoded = requireString(args, 'content_base64')
      checkAssetName(name)
      // The name it will really have has to pass too.
      const cleaned = importedAssetFilename(name.trim())
      checkAssetName(cleaned)
      return await backend.importAsset(cleaned, decodeAssetBase64(encoded))
    }
  },
  {
    schema: {
      name: 'rename_asset',
      description:
        'Rename an attachment in place. Notes that embed or link it are updated to the new name; `linksNotUpdated` lists any it could not read or write, which may still use the old name, so fix those by hand. Names holding # ? | [ ] ^ or % are refused, since links could not reach the file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          name: { type: 'string', description: 'New file name with its extension, no folder.' }
        },
        required: ['path', 'name']
      }
    },
    handler: async (args, backend) => {
      const rel = requireString(args, 'path')
      const name = requireString(args, 'name')
      checkAssetNewName(name)
      const { meta } = await findAsset(backend, rel)
      await refuseDatabaseFile(meta, backend)
      return await backend.renameAsset(meta.path, name.trim())
    }
  },
  {
    schema: {
      name: 'move_asset',
      description:
        'Move an attachment to another folder, creating it if needed. Notes that embed or link it are updated; `linksNotUpdated` lists any it could not read or write, which may still use the old name. A taken name gets a number, so use the returned `path`.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          targetDir: { type: 'string', description: 'Vault-relative folder, such as assets/plots.' }
        },
        required: ['path', 'targetDir']
      }
    },
    handler: async (args, backend) => {
      const rel = requireString(args, 'path')
      const rawDir = requireString(args, 'targetDir')
      const { meta } = await findAsset(backend, rel)
      await refuseDatabaseFile(meta, backend)
      return await backend.moveAsset(meta.path, await checkAssetTargetDir(backend, rawDir))
    }
  },
  {
    schema: {
      name: 'duplicate_asset',
      description: 'Copy an attachment next to itself with a " copy" suffix.',
      inputSchema: PATH_ONLY_SCHEMA
    },
    handler: async (args, backend) => {
      const { meta } = await findAsset(backend, requireString(args, 'path'))
      await refuseDatabaseFile(meta, backend)
      return await backend.duplicateAsset(meta.path)
    }
  },
  {
    schema: {
      name: 'delete_asset',
      description:
        "Soft-delete an attachment: it leaves the vault for the app's Trash and restore_asset brings it back. Keep the returned undoToken. Notes keep their links to it, so check them first with search_text.",
      inputSchema: PATH_ONLY_SCHEMA
    },
    handler: async (args, backend) => {
      const { meta } = await findAsset(backend, requireString(args, 'path'))
      await refuseDatabaseFile(meta, backend)
      return await backend.deleteAsset(meta.path)
    }
  },
  {
    schema: {
      name: 'restore_asset',
      description:
        'Bring back a deleted attachment to where it was, using the undoToken from delete_asset or list_assets with deleted: true. A taken name gets a number, so use the returned `path`.',
      inputSchema: {
        type: 'object',
        properties: { undoToken: { type: 'string' } },
        required: ['undoToken']
      }
    },
    handler: async (args, backend) => {
      const token = requireString(args, 'undoToken')
      const entry = (await backend.listDeletedAssets()).find((d) => d.undoToken === token)
      if (!entry) throw deletedAssetNotFound(token)
      return await backend.restoreDeletedAsset(entry)
    }
  }
]

export const LIST_ASSETS_TOOL: ToolDef = {
  schema: {
    name: 'list_assets',
    description:
      "List the vault’s attachments: every file that is not a note, wherever it is (images, PDFs, audio, video, other binaries). Useful when a note references an asset you need to inspect. With deleted: true, lists the attachments in the app's Trash instead, with the undoToken restore_asset takes.",
    inputSchema: {
      type: 'object',
      properties: {
        deleted: { type: 'boolean', description: 'List deleted attachments instead.' }
      }
    }
  },
  handler: async (args, backend) => {
    if (optionalBoolean(args, 'deleted')) return await backend.listDeletedAssets()
    return (await backend.listAssets()).filter((asset) => !isLooseCsvInternal(asset.path))
  }
}

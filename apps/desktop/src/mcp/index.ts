#!/usr/bin/env node
/**
 * ZenNotes MCP server. Spawned over stdio by Claude Code, Claude
 * Desktop, Codex, or any other MCP-compatible client. Exposes the
 * vault operations defined in ./vault-ops as MCP tools, and ships a
 * note-taker-focused system instruction so the model knows how to
 * behave against real human-curated notes.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool
} from '@modelcontextprotocol/sdk/types.js'

import { resolveInstructions } from './instructions-store.js'
import {
  appendToNote,
  archiveNote,
  backlinks,
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  duplicateNote,
  emptyTrash,
  insertAtLine,
  listAssets,
  listFolders,
  listNotes,
  moveNote,
  moveToTrash,
  prependToNote,
  readNote,
  renameFolder,
  renameNote,
  replaceInNote,
  resolveVaultRoot,
  restoreFromTrash,
  scanAllTasks,
  searchText,
  toggleTask,
  unarchiveNote,
  writeNote,
  type NoteFolder
} from './vault-ops.js'

interface ToolDef {
  schema: Tool
  handler: (args: Record<string, unknown>, vault: string) => Promise<unknown>
}

/* ---------- Argument helpers ----------------------------------------- */

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required string argument: ${key}`)
  }
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value == null) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

function requireFolder(args: Record<string, unknown>, key: string): NoteFolder {
  const value = requireString(args, key)
  if (value !== 'inbox' && value !== 'quick' && value !== 'archive' && value !== 'trash') {
    throw new Error(`${key} must be one of inbox, quick, archive, trash`)
  }
  return value
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number`)
  }
  return value
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  if (value == null) return undefined
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  return value
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key]
  if (value == null) return undefined
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(`${key} must be an array of strings`)
  }
  return value as string[]
}

/* ---------- Tool definitions ----------------------------------------- */

const TOOLS: ToolDef[] = [
  {
    schema: {
      name: 'vault_info',
      description:
        'Return the absolute path and top-level layout of the currently configured ZenNotes vault. Call this once at the start of a session to confirm you are pointing at the right vault.',
      inputSchema: { type: 'object', properties: {} }
    },
    handler: async (_args, vault) => {
      const folders = await listFolders(vault)
      return {
        vaultRoot: vault,
        topFolders: ['inbox', 'quick', 'archive', 'trash'],
        subfolders: folders
      }
    }
  },
  {
    schema: {
      name: 'list_notes',
      description:
        "List notes in the vault with metadata (title, folder, tags, wikilinks, excerpt, timestamps). Optional filters narrow by folder, tag, or wikilink target. Use this before editing to pick the right note. Trashed notes are included only when folder='trash' is explicit.",
      inputSchema: {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            enum: ['inbox', 'quick', 'archive', 'trash'],
            description: 'Only return notes in this top-level folder.'
          },
          subpath: {
            type: 'string',
            description:
              'POSIX subpath under the folder (e.g. "Work/Meetings"). Requires folder to be set.'
          },
          tag: { type: 'string', description: 'Only return notes that contain this #tag.' },
          wikilinkTo: {
            type: 'string',
            description: 'Only return notes that link to a note with this title.'
          },
          updatedSinceMs: {
            type: 'number',
            description: 'Only return notes updated at or after this epoch millisecond timestamp.'
          },
          limit: {
            type: 'number',
            description: 'Cap the number of notes returned. Default: 200.'
          }
        }
      }
    },
    handler: async (args, vault) => {
      const folder = args.folder ? requireFolder(args, 'folder') : null
      const sub = optionalString(args, 'subpath')
      const tag = optionalString(args, 'tag')?.toLowerCase()
      const wikilinkTo = optionalString(args, 'wikilinkTo')?.toLowerCase()
      const since = optionalNumber(args, 'updatedSinceMs')
      const limit = optionalNumber(args, 'limit') ?? 200
      let notes = await listNotes(vault)
      if (folder) notes = notes.filter((n) => n.folder === folder)
      else notes = notes.filter((n) => n.folder !== 'trash')
      if (sub) {
        const prefix = `${folder ?? ''}/${sub.replace(/^\/+|\/+$/g, '')}/`
        notes = notes.filter((n) => n.path.startsWith(prefix))
      }
      if (tag) notes = notes.filter((n) => n.tags.map((t) => t.toLowerCase()).includes(tag))
      if (wikilinkTo) {
        notes = notes.filter((n) =>
          n.wikilinks.some((w) => w.toLowerCase() === wikilinkTo)
        )
      }
      if (since != null) notes = notes.filter((n) => n.updatedAt >= since)
      notes.sort((a, b) => b.updatedAt - a.updatedAt)
      return notes.slice(0, limit)
    }
  },
  {
    schema: {
      name: 'list_folders',
      description: 'List every subfolder in the vault grouped by top-level folder.',
      inputSchema: { type: 'object', properties: {} }
    },
    handler: async (_args, vault) => await listFolders(vault)
  },
  {
    schema: {
      name: 'list_assets',
      description:
        'List files under the vault\u2019s attachments directory (images, PDFs, audio, video, other binaries). Useful when a note references an asset you need to inspect.',
      inputSchema: { type: 'object', properties: {} }
    },
    handler: async (_args, vault) => await listAssets(vault)
  },
  {
    schema: {
      name: 'read_note',
      description:
        'Read the full body and metadata of a single note. Always read before you write.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative POSIX path to the note, e.g. "inbox/Project.md".'
          }
        },
        required: ['path']
      }
    },
    handler: async (args, vault) => {
      const rel = requireString(args, 'path')
      return await readNote(vault, rel)
    }
  },
  {
    schema: {
      name: 'write_note',
      description:
        'Overwrite the full body of an existing note. Destructive \u2014 prefer append_to_note / replace_in_note for incremental edits. Keep frontmatter intact unless the user asked you to change it.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault-relative POSIX path.' },
          body: { type: 'string', description: 'New full markdown body.' }
        },
        required: ['path', 'body']
      }
    },
    handler: async (args, vault) => {
      const rel = requireString(args, 'path')
      const body = args['body']
      if (typeof body !== 'string') throw new Error('body must be a string')
      return await writeNote(vault, rel, body)
    }
  },
  {
    schema: {
      name: 'create_note',
      description:
        'Create a new note. Always picks a non-conflicting filename by appending a counter if needed. Default folder is "inbox".',
      inputSchema: {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            enum: ['inbox', 'quick', 'archive'],
            description: 'Top-level folder. Refuses "trash".'
          },
          title: {
            type: 'string',
            description:
              'Human-readable title. Becomes the filename (sanitized). Optional; defaults to "Untitled".'
          },
          subpath: {
            type: 'string',
            description:
              'POSIX subpath under the folder. Example: "Work/Research". Missing parents are created.'
          },
          body: {
            type: 'string',
            description: 'Initial markdown body. Defaults to "# <title>\\n\\n".'
          }
        },
        required: ['folder']
      }
    },
    handler: async (args, vault) => {
      const folder = requireFolder(args, 'folder')
      if (folder === 'trash') throw new Error('Refusing to create a note directly in trash/')
      const title = optionalString(args, 'title')
      const subpath = optionalString(args, 'subpath') ?? ''
      const body = optionalString(args, 'body')
      return await createNote(vault, folder, title, subpath, body)
    }
  },
  {
    schema: {
      name: 'rename_note',
      description:
        'Rename a note in place (filename only, same folder). Check backlinks() first so you can warn the user about dangling wikilinks.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          newTitle: { type: 'string' }
        },
        required: ['path', 'newTitle']
      }
    },
    handler: async (args, vault) => {
      const rel = requireString(args, 'path')
      const title = requireString(args, 'newTitle')
      return await renameNote(vault, rel, title)
    }
  },
  {
    schema: {
      name: 'move_note',
      description:
        'Move a note to a new folder or subfolder. Use archive_note/unarchive_note/move_to_trash for the special destinations rather than this tool.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          targetFolder: { type: 'string', enum: ['inbox', 'quick', 'archive', 'trash'] },
          targetSubpath: { type: 'string', description: 'Optional POSIX subpath under the folder.' }
        },
        required: ['path', 'targetFolder']
      }
    },
    handler: async (args, vault) => {
      const rel = requireString(args, 'path')
      const folder = requireFolder(args, 'targetFolder')
      const sub = optionalString(args, 'targetSubpath') ?? ''
      return await moveNote(vault, rel, folder, sub)
    }
  },
  {
    schema: {
      name: 'duplicate_note',
      description: 'Duplicate a note next to itself with a " copy" suffix.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    },
    handler: async (args, vault) => await duplicateNote(vault, requireString(args, 'path'))
  },
  {
    schema: {
      name: 'move_to_trash',
      description: 'Soft-delete: move the note into trash/. Reversible via restore_from_trash.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    },
    handler: async (args, vault) => await moveToTrash(vault, requireString(args, 'path'))
  },
  {
    schema: {
      name: 'restore_from_trash',
      description: 'Restore a trashed note back to inbox/.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    },
    handler: async (args, vault) => await restoreFromTrash(vault, requireString(args, 'path'))
  },
  {
    schema: {
      name: 'empty_trash',
      description:
        'Permanently delete every note in trash/. Confirm with the user before calling \u2014 this is irreversible.',
      inputSchema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            description: 'Must be true. Prevents accidental triggers.'
          }
        },
        required: ['confirm']
      }
    },
    handler: async (args, vault) => {
      if (args.confirm !== true) {
        throw new Error('empty_trash requires confirm=true. Ask the user first.')
      }
      await emptyTrash(vault)
      return { ok: true }
    }
  },
  {
    schema: {
      name: 'delete_note',
      description:
        'Permanently delete a single note file. Prefer move_to_trash unless the user explicitly asked for a hard delete.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          confirm: { type: 'boolean' }
        },
        required: ['path', 'confirm']
      }
    },
    handler: async (args, vault) => {
      if (args.confirm !== true) throw new Error('delete_note requires confirm=true.')
      await deleteNote(vault, requireString(args, 'path'))
      return { ok: true }
    }
  },
  {
    schema: {
      name: 'archive_note',
      description: 'Move a note into archive/.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    },
    handler: async (args, vault) => await archiveNote(vault, requireString(args, 'path'))
  },
  {
    schema: {
      name: 'unarchive_note',
      description: 'Move an archived note back to inbox/.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    },
    handler: async (args, vault) => await unarchiveNote(vault, requireString(args, 'path'))
  },
  {
    schema: {
      name: 'create_folder',
      description: 'Create a subfolder under inbox/, quick/, or archive/.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', enum: ['inbox', 'quick', 'archive'] },
          subpath: { type: 'string' }
        },
        required: ['folder', 'subpath']
      }
    },
    handler: async (args, vault) => {
      const folder = requireFolder(args, 'folder')
      if (folder === 'trash') throw new Error('Refusing to create subfolders inside trash/')
      await createFolder(vault, folder, requireString(args, 'subpath'))
      return { ok: true }
    }
  },
  {
    schema: {
      name: 'rename_folder',
      description: 'Rename or move a subfolder in place.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', enum: ['inbox', 'quick', 'archive'] },
          oldSubpath: { type: 'string' },
          newSubpath: { type: 'string' }
        },
        required: ['folder', 'oldSubpath', 'newSubpath']
      }
    },
    handler: async (args, vault) => {
      const folder = requireFolder(args, 'folder')
      if (folder === 'trash') throw new Error('Cannot rename inside trash/')
      return await renameFolder(
        vault,
        folder,
        requireString(args, 'oldSubpath'),
        requireString(args, 'newSubpath')
      )
    }
  },
  {
    schema: {
      name: 'delete_folder',
      description:
        'Delete a subfolder and everything inside it. Destructive. Confirm with the user first.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', enum: ['inbox', 'quick', 'archive'] },
          subpath: { type: 'string' },
          confirm: { type: 'boolean' }
        },
        required: ['folder', 'subpath', 'confirm']
      }
    },
    handler: async (args, vault) => {
      if (args.confirm !== true) throw new Error('delete_folder requires confirm=true.')
      const folder = requireFolder(args, 'folder')
      if (folder === 'trash') throw new Error('Cannot delete inside trash/')
      await deleteFolder(vault, folder, requireString(args, 'subpath'))
      return { ok: true }
    }
  },
  {
    schema: {
      name: 'search_text',
      description:
        'Full-text search across live notes (inbox/quick/archive). Returns line-level matches with path, line number, and preview. Cheap first step when the user says "find" or "where did I write".',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' }
        },
        required: ['query']
      }
    },
    handler: async (args, vault) => {
      const query = requireString(args, 'query')
      const limit = optionalNumber(args, 'limit') ?? 80
      return await searchText(vault, query, limit)
    }
  },
  {
    schema: {
      name: 'search_by_title',
      description:
        'Fuzzy-match notes by title (case-insensitive substring). Good for "open my note about …".',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' }
        },
        required: ['query']
      }
    },
    handler: async (args, vault) => {
      const needle = requireString(args, 'query').toLowerCase()
      const limit = optionalNumber(args, 'limit') ?? 20
      const all = await listNotes(vault)
      return all
        .filter((n) => n.folder !== 'trash' && n.title.toLowerCase().includes(needle))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
    }
  },
  {
    schema: {
      name: 'search_by_tag',
      description:
        'Find notes carrying a specific inline #tag. Tags are case-insensitive; pass the name with or without the leading #.',
      inputSchema: {
        type: 'object',
        properties: {
          tag: { type: 'string' },
          limit: { type: 'number' }
        },
        required: ['tag']
      }
    },
    handler: async (args, vault) => {
      const raw = requireString(args, 'tag').replace(/^#/, '').toLowerCase()
      const limit = optionalNumber(args, 'limit') ?? 200
      const all = await listNotes(vault)
      return all
        .filter(
          (n) => n.folder !== 'trash' && n.tags.map((t) => t.toLowerCase()).includes(raw)
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
    }
  },
  {
    schema: {
      name: 'list_tags',
      description:
        'Enumerate every #tag used in the vault (excluding trash) with the count of notes carrying it.',
      inputSchema: { type: 'object', properties: {} }
    },
    handler: async (_args, vault) => {
      const all = await listNotes(vault)
      const counts = new Map<string, number>()
      for (const n of all) {
        if (n.folder === 'trash') continue
        for (const t of n.tags) {
          const key = t.toLowerCase()
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
      }
      return [...counts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    }
  },
  {
    schema: {
      name: 'backlinks',
      description:
        'Return every note that links to the given note via [[wikilink]]. Run this before renaming a note \u2014 the rename will orphan these links.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault-relative path to the target note.' }
        },
        required: ['path']
      }
    },
    handler: async (args, vault) => await backlinks(vault, requireString(args, 'path'))
  },
  {
    schema: {
      name: 'list_tasks',
      description:
        'Return every task (markdown checkbox) in live notes with parsed metadata: due date, priority, @waiting, tags. Filter by status, priority, date range, tag, or folder.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['open', 'done', 'waiting', 'all'],
            description:
              'open = unchecked & not waiting (default). done = checked. waiting = has @waiting. all = everything.'
          },
          priority: {
            type: 'string',
            enum: ['high', 'med', 'low'],
            description: 'Only tasks at this priority.'
          },
          dueBefore: { type: 'string', description: 'YYYY-MM-DD exclusive upper bound.' },
          dueAfter: { type: 'string', description: 'YYYY-MM-DD inclusive lower bound.' },
          tag: { type: 'string' },
          folder: {
            type: 'string',
            enum: ['inbox', 'quick', 'archive']
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Alternative to tag: require ALL of these tags.'
          }
        }
      }
    },
    handler: async (args, vault) => {
      const status = (optionalString(args, 'status') as
        | 'open'
        | 'done'
        | 'waiting'
        | 'all'
        | undefined) ?? 'open'
      const priority = optionalString(args, 'priority') as 'high' | 'med' | 'low' | undefined
      const dueBefore = optionalString(args, 'dueBefore')
      const dueAfter = optionalString(args, 'dueAfter')
      const tag = optionalString(args, 'tag')?.toLowerCase()
      const tags = optionalStringArray(args, 'tags')?.map((t) => t.toLowerCase())
      const folder = args.folder
        ? (requireFolder(args, 'folder') as 'inbox' | 'quick' | 'archive')
        : null
      const all = await scanAllTasks(vault)
      return all.filter((t) => {
        if (folder && t.noteFolder !== folder) return false
        if (status === 'open' && (t.checked || t.waiting)) return false
        if (status === 'done' && !t.checked) return false
        if (status === 'waiting' && !t.waiting) return false
        if (priority && t.priority !== priority) return false
        if (dueBefore && (!t.due || t.due >= dueBefore)) return false
        if (dueAfter && (!t.due || t.due < dueAfter)) return false
        if (tag && !t.tags.map((x) => x.toLowerCase()).includes(tag)) return false
        if (tags && !tags.every((need) => t.tags.map((x) => x.toLowerCase()).includes(need))) {
          return false
        }
        return true
      })
    }
  },
  {
    schema: {
      name: 'toggle_task',
      description:
        'Flip a task\u2019s checkbox state using its stable id from list_tasks ("<path>#<index>"). Returns the updated task, or null if the id no longer matches a task (content drifted).',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Stable task id: sourcePath#taskIndex.'
          }
        },
        required: ['id']
      }
    },
    handler: async (args, vault) => await toggleTask(vault, requireString(args, 'id'))
  },
  {
    schema: {
      name: 'append_to_note',
      description:
        'Append markdown to the end of a note (inserts a blank line separator if needed). Preferred for adding entries to daily logs, running lists, meeting notes.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          text: { type: 'string', description: 'Markdown to append (no leading newline needed).' }
        },
        required: ['path', 'text']
      }
    },
    handler: async (args, vault) => {
      const rel = requireString(args, 'path')
      const text = requireString(args, 'text')
      return await appendToNote(vault, rel, text)
    }
  },
  {
    schema: {
      name: 'prepend_to_note',
      description:
        'Insert markdown at the top of a note, after any frontmatter block. Good for "pin this to the top" or adding a banner.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          text: { type: 'string' }
        },
        required: ['path', 'text']
      }
    },
    handler: async (args, vault) => {
      const rel = requireString(args, 'path')
      const text = requireString(args, 'text')
      return await prependToNote(vault, rel, text)
    }
  },
  {
    schema: {
      name: 'insert_at_line',
      description:
        'Insert text before a given zero-based line number. Line numbers come from read_note or list_tasks (which reports lineNumber).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          lineNumber: { type: 'number', description: 'Zero-based line number.' },
          text: { type: 'string' }
        },
        required: ['path', 'lineNumber', 'text']
      }
    },
    handler: async (args, vault) => {
      const rel = requireString(args, 'path')
      const lineNumber = optionalNumber(args, 'lineNumber')
      if (lineNumber == null) throw new Error('lineNumber is required')
      const text = requireString(args, 'text')
      return await insertAtLine(vault, rel, lineNumber, text)
    }
  },
  {
    schema: {
      name: 'replace_in_note',
      description:
        'Literal (non-regex) find-and-replace inside a single note. Returns the number of replacements made. Default scope: first occurrence.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          find: { type: 'string' },
          replace: { type: 'string' },
          occurrence: {
            type: 'string',
            enum: ['first', 'all'],
            description: 'Default: "first".'
          }
        },
        required: ['path', 'find', 'replace']
      }
    },
    handler: async (args, vault) => {
      const rel = requireString(args, 'path')
      const find = requireString(args, 'find')
      const replace = args.replace
      if (typeof replace !== 'string') throw new Error('replace must be a string')
      const occurrence = (optionalString(args, 'occurrence') as 'first' | 'all' | undefined) ?? 'first'
      return await replaceInNote(vault, rel, find, replace, occurrence)
    }
  }
]

/* ---------- Server plumbing ------------------------------------------ */

async function main(): Promise<void> {
  // Resolve the vault up front so we fail fast with a clear error
  // instead of surprising every tool call. When the user hasn't picked
  // a vault yet we still boot so the client surface stays consistent,
  // but every tool call will report the missing-vault error.
  let vaultPromise: Promise<string> | null = null
  const getVault = (): Promise<string> => {
    if (!vaultPromise) vaultPromise = resolveVaultRoot()
    return vaultPromise
  }

  const instructions = await resolveInstructions()
  const server = new Server(
    { name: 'zennotes', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions
    }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => t.schema)
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const tool = TOOLS.find((t) => t.schema.name === name)
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true
      }
    }
    try {
      const vault = await getVault()
      const result = await tool.handler((args ?? {}) as Record<string, unknown>, vault)
      const payload =
        typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      return { content: [{ type: 'text', text: payload }] }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true
      }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[zennotes-mcp] fatal', err)
  process.exit(1)
})

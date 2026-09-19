/**
 * Minimal argument parser for the `zn` CLI. Supports:
 *   zn <command> [<subcommand>] [positional...] [--flag value | --flag=value | -x value]
 * Repeated flags (e.g. `--tag a --tag b`) collect into an array via getMany().
 * Boolean flags are inferred when no value follows or when the next token
 * starts with `--`, and the flags in VALUELESS_FLAGS never take one.
 */

export interface ParsedArgs {
  /** Positional, non-flag tokens after the command/subcommand. */
  positionals: string[]
  /** Flag values keyed by long name (without leading `--`). Each entry is
   *  the array of every value seen for that flag, in order. */
  flags: Map<string, string[]>
}

/**
 * Long flags that are switches, never `--flag <value>`. Without this list a
 * switch written before a positional swallowed it: `zn open --new-window
 * ~/notes` parsed as new-window="~/notes" and no path (#815), and `zn delete
 * --yes inbox/a.md` the same way. `--flag=value` still works for all of them.
 * The Go CLI's parser mirrors this list; keep the two in sync.
 */
export const VALUELESS_FLAGS: ReadonlySet<string> = new Set([
  'all',
  'include-excluded',
  'json',
  'meta',
  'new-window',
  'page',
  'reopen',
  'unchecked',
  'yes'
])

export function parse(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string[]>()

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') {
      // Everything after `--` is positional. Useful for note bodies that
      // happen to start with `--`.
      for (let j = i + 1; j < argv.length; j++) positionals.push(argv[j])
      break
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      if (eq >= 0) {
        const name = token.slice(2, eq)
        const value = token.slice(eq + 1)
        push(flags, name, value)
        continue
      }
      const name = token.slice(2)
      const next = argv[i + 1]
      if (!VALUELESS_FLAGS.has(name) && next != null && !next.startsWith('--')) {
        push(flags, name, next)
        i += 1
      } else {
        push(flags, name, 'true')
      }
      continue
    }
    if (/^-[A-Za-z][\w-]*$/.test(token)) {
      // Short flag (e.g. `-h`). Only a dash followed by a letter counts as a
      // flag; text that merely starts with `-` — a markdown task `- [ ] …`, a
      // list item, or a negative number — stays positional so
      // `zn capture "- [ ] task"` works. Boolean only (no value / `-abc`
      // combining — unnecessary for our surface).
      push(flags, token.slice(1), 'true')
      continue
    }
    positionals.push(token)
  }
  return { positionals, flags }
}

function push(flags: Map<string, string[]>, name: string, value: string): void {
  const existing = flags.get(name)
  if (existing) existing.push(value)
  else flags.set(name, [value])
}

export function getString(args: ParsedArgs, name: string): string | undefined {
  const values = args.flags.get(name)
  return values && values.length > 0 ? values[values.length - 1] : undefined
}

export function getBool(args: ParsedArgs, name: string): boolean {
  const v = getString(args, name)
  if (v == null) return false
  return v === 'true' || v === '1' || v === 'yes'
}

export function getNumber(args: ParsedArgs, name: string): number | undefined {
  const v = getString(args, name)
  if (v == null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function getMany(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? []
}

/**
 * Read all of stdin to a string. Used when `--body -` or a positional
 * `-` is given, and as the implicit input for `zn capture`.
 */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Resolve `--body` / positional body conventions:
 *   --body "literal"        => "literal"
 *   --body -                => stdin
 *   (no flag, stdin piped)  => stdin
 *   (nothing)               => undefined
 */
export async function resolveBody(
  args: ParsedArgs,
  fallbackPositional?: string
): Promise<string | undefined> {
  const flag = getString(args, 'body')
  if (flag === '-') return await readStdin()
  if (flag != null) return flag
  if (fallbackPositional != null && fallbackPositional !== '') return fallbackPositional
  if (!process.stdin.isTTY) {
    const piped = await readStdin()
    if (piped.trim()) return piped
  }
  return undefined
}

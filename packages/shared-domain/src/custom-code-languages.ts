import type { CustomCodeLanguageManifest } from '@zennotes/bridge-contract/custom-code-languages'
export type {
  CustomCodeLanguageManifest,
  CustomCodeLanguage,
  CustomCodeLanguageInstallInput,
  CustomCodeLanguageUpdateInput
} from '@zennotes/bridge-contract/custom-code-languages'

/** Shared contract and validation for user-installed TextMate code languages. */

export const CUSTOM_CODE_LANGUAGE_SCHEMA_VERSION = 1;
export const CUSTOM_CODE_LANGUAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Tags with app-defined behavior or bundled editor/preview grammars.
 *
 * This is the single authority on "a built-in already owns this tag", and it
 * has to stay a superset of every tag any highlighting layer claims, because
 * the layers disagree about how they match: the preview runs lowlight, the
 * editor runs `@codemirror/language-data` (whose matcher is substring-fuzzy),
 * and the app itself owns a handful of diagram and embed fences. A tag missing
 * from this list either shadows a built-in in one surface, or installs fine and
 * then renders as plain text in the other. Enumerated by hand rather than
 * imported so shared-domain stays dependency-free; regenerate from
 * `lowlight`'s `common` + `hljs.getLanguage(name).aliases` and
 * `@codemirror/language-data`'s `name`/`alias` fields when either is upgraded,
 * dropping entries that are not legal fence tags ("plain text", "vb.net", …).
 */
export const RESERVED_CODE_FENCE_TAGS = [
  "javascript",
  "js",
  "jsx",
  "node",
  "nodejs",
  "typescript",
  "ts",
  "tsx",
  "python",
  "py",
  "python3",
  "rust",
  "rs",
  "go",
  "golang",
  "json",
  "jsonc",
  "cpp",
  "c++",
  "c",
  "cc",
  "cxx",
  "hpp",
  "h",
  "java",
  "html",
  "htm",
  "css",
  "sql",
  "mysql",
  "postgres",
  "postgresql",
  "sqlite",
  "xml",
  "svg",
  "yaml",
  "yml",
  "markdown",
  "md",
  "php",
  "bash",
  "sh",
  "shell",
  "zsh",
  "powershell",
  "ps1",
  "lua",
  "ruby",
  "rb",
  "swift",
  "kotlin",
  "scala",
  "r",
  "perl",
  "diff",
  "dockerfile",
  "ini",
  "toml",
  "makefile",
  "cql",
  "cassandra",
  "xhtml",
  "ecmascript",
  "jinja",
  "json5",
  "less",
  "liquid",
  "plsql",
  "sass",
  "scss",
  "webassembly",
  "wasm",
  "rss",
  "wsdl",
  "xsd",
  "apl",
  "pgp",
  "asciiarmor",
  "asterisk",
  "brainfuck",
  "cobol",
  "c#",
  "csharp",
  "cs",
  "clojure",
  "clojurescript",
  "cmake",
  "coffeescript",
  "coffee",
  "coffee-script",
  "lisp",
  "cypher",
  "cython",
  "crystal",
  "d",
  "dart",
  "dtd",
  "dylan",
  "ebnf",
  "ecl",
  "edn",
  "eiffel",
  "elm",
  "erlang",
  "esper",
  "factor",
  "fcl",
  "forth",
  "fortran",
  "f#",
  "fsharp",
  "gas",
  "gherkin",
  "graphql",
  "groovy",
  "haskell",
  "haxe",
  "hxml",
  "http",
  "idl",
  "json-ld",
  "jsonld",
  "julia",
  "livescript",
  "ls",
  "mirc",
  "mathematica",
  "modelica",
  "mumps",
  "mbox",
  "nginx",
  "nsis",
  "ntriples",
  "objective-c",
  "objectivec",
  "objc",
  "objective-c++",
  "objc++",
  "ocaml",
  "octave",
  "oz",
  "pascal",
  "pig",
  "plaintext",
  "properties",
  "protobuf",
  "pug",
  "jade",
  "puppet",
  "q",
  "rscript",
  "jruby",
  "macruby",
  "rake",
  "rbx",
  "sas",
  "scheme",
  "sieve",
  "smalltalk",
  "solr",
  "sml",
  "sparql",
  "sparul",
  "spreadsheet",
  "excel",
  "formula",
  "squirrel",
  "stylus",
  "stex",
  "latex",
  "tex",
  "systemverilog",
  "tcl",
  "textile",
  "tiddlywiki",
  "troff",
  "ttcn",
  "ttcn_cfg",
  "turtle",
  "vbnet",
  "vbscript",
  "velocity",
  "verilog",
  "vhdl",
  "xquery",
  "yacas",
  "z80",
  "mscgen",
  "msgenny",
  "vue",
  "php-template",
  "python-repl",
  "mermaid",
  "tikz",
  "jsxgraph",
  "function-plot",
  "functionplot",
  // App-owned fences that the preview turns into a widget rather than code.
  "embed",
  "bookmark",
  // Names and aliases from lowlight's `common` bundle that the list above did
  // not already cover. rehype-highlight runs on every rendered note, so a
  // custom language claiming one of these would lose the preview to lowlight
  // while still winning the editor.
  "arduino",
  "ino",
  "atom",
  "cjs",
  "mjs",
  "cts",
  "mts",
  "console",
  "shellsession",
  "pycon",
  "ipython",
  "irb",
  "gemspec",
  "podspec",
  "thor",
  "gql",
  "gyp",
  "h++",
  "hh",
  "hxx",
  "jsp",
  "kt",
  "kts",
  "mak",
  "make",
  "mk",
  "mkd",
  "mkdown",
  "mm",
  "obj-c",
  "obj-c++",
  "patch",
  "pl",
  "pm",
  "plist",
  "pluto",
  "text",
  "txt",
  "vb",
  "wsf",
  "xjb",
  "xsl",
] as const;

let reservedTagSet: Set<string> | null = null;

/**
 * True when a bundled grammar or an app fence already owns this tag. Callers
 * that decide "built-in or custom?" at render time must use this rather than
 * CodeMirror's `matchLanguageName`, whose fuzzy mode matches on substrings and
 * so hands `jsonnet` to JSON and `crystalline` to Crystal.
 */
export function isReservedCodeFenceTag(tag: string): boolean {
  reservedTagSet ??= new Set<string>(RESERVED_CODE_FENCE_TAGS);
  return reservedTagSet.has(normalizeCodeFenceTag(tag));
}

export interface ParsedTextMateGrammar {
  raw: Record<string, unknown>;
  name?: string;
  scopeName: string;
}

export interface CustomCodeLanguageValidationOptions {
  reservedAliases?: Iterable<string>;
  existing?: Iterable<Pick<CustomCodeLanguageManifest, "id" | "aliases">>;
  replacingId?: string;
}

export function normalizeCodeFenceTag(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidCodeFenceTag(value: string): boolean {
  return /^[a-z0-9][a-z0-9_+#-]{0,63}$/.test(value);
}

export function parseTextMateGrammar(text: string): ParsedTextMateGrammar {
  if (
    new TextEncoder().encode(text).byteLength > CUSTOM_CODE_LANGUAGE_MAX_BYTES
  ) {
    throw new Error("Grammar files must be 2 MB or smaller.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("This file is not valid JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("The TextMate grammar must be a JSON object.");
  }
  const grammar = raw as Record<string, unknown>;
  const scopeName =
    typeof grammar.scopeName === "string" ? grammar.scopeName.trim() : "";
  if (!/^(?:source|text)\.[a-z0-9_.+-]+$/i.test(scopeName)) {
    throw new Error(
      'The grammar needs a valid scopeName such as "source.gleam".',
    );
  }
  if (!Array.isArray(grammar.patterns)) {
    throw new Error("The grammar needs a top-level patterns array.");
  }

  const unsupported = collectExternalIncludes(grammar, scopeName);
  if (unsupported.length > 0) {
    throw new Error(
      `This grammar depends on unsupported external scopes: ${unsupported.join(", ")}. ` +
        "The first release supports self-contained TextMate grammars.",
    );
  }
  return {
    raw: grammar,
    name:
      typeof grammar.name === "string" && grammar.name.trim()
        ? grammar.name.trim()
        : undefined,
    scopeName,
  };
}

export function validateCustomCodeLanguageManifest(
  input: Omit<CustomCodeLanguageManifest, "schemaVersion" | "scopeName"> & {
    scopeName: string;
  },
  options: CustomCodeLanguageValidationOptions = {},
): CustomCodeLanguageManifest {
  const id = normalizeCodeFenceTag(input.id);
  if (!isValidCodeFenceTag(id)) {
    throw new Error(
      "Fence tags must start with a letter or number and use only a-z, 0-9, _, +, #, or -.",
    );
  }
  const name = input.name.trim();
  if (!name || name.length > 80)
    throw new Error("Language names must be between 1 and 80 characters.");

  const aliases = Array.from(
    new Set([id, ...input.aliases.map(normalizeCodeFenceTag)].filter(Boolean)),
  );
  if (aliases.some((alias) => !isValidCodeFenceTag(alias))) {
    throw new Error("Every alias must be a valid fenced-code tag.");
  }
  if (aliases.length > 16)
    throw new Error("A language can have at most 16 fence-tag aliases.");

  const reserved = new Set(
    Array.from(options.reservedAliases ?? [], normalizeCodeFenceTag),
  );
  const reservedMatch = aliases.find((alias) => reserved.has(alias));
  if (reservedMatch)
    throw new Error(
      `The fence tag “${reservedMatch}” is reserved by ZenNotes.`,
    );

  for (const other of options.existing ?? []) {
    if (other.id === options.replacingId) continue;
    const occupied = new Set(
      [other.id, ...other.aliases].map(normalizeCodeFenceTag),
    );
    const conflict = aliases.find((alias) => occupied.has(alias));
    if (conflict)
      throw new Error(
        `The fence tag “${conflict}” is already used by another custom language.`,
      );
  }

  return {
    schemaVersion: CUSTOM_CODE_LANGUAGE_SCHEMA_VERSION,
    id,
    name,
    aliases,
    scopeName: input.scopeName,
    enabled: input.enabled,
  };
}

function collectExternalIncludes(
  grammar: Record<string, unknown>,
  ownScope: string,
): string[] {
  const found = new Set<string>();
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value as object))
      return;
    seen.add(value as object);
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.include === "string") {
      const include = record.include.trim();
      if (
        include &&
        include !== "$self" &&
        include !== "$base" &&
        !include.startsWith("#") &&
        include !== ownScope &&
        !include.startsWith(`${ownScope}#`)
      ) {
        found.add(include.split("#")[0]);
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(grammar);
  return Array.from(found).sort();
}

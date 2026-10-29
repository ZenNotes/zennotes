/** Desktop filesystem lifecycle for user-installed TextMate grammars. */
import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import chokidar from "chokidar";
import {
  RESERVED_CODE_FENCE_TAGS,
  normalizeCodeFenceTag,
  parseTextMateGrammar,
  validateCustomCodeLanguageManifest,
  type CustomCodeLanguage,
  type CustomCodeLanguageInstallInput,
  type CustomCodeLanguageManifest,
  type CustomCodeLanguageUpdateInput,
} from "@shared/custom-code-languages";
import { getConfigDir } from "./app-config";

const README = `# ZenNotes custom code languages

Each installed language has its own folder containing a manifest and a
self-contained TextMate JSON grammar. Use Settings → Editor → Languages to
install, edit, enable, disable, or remove languages safely.

\`\`\`
languages/
  gleam/
    manifest.json
    grammar.tmLanguage.json
\`\`\`
`;

export function getCustomCodeLanguagesDir(): string {
  return path.join(getConfigDir(), "languages");
}

function isSafeId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9][a-z0-9_+#-]{0,63}$/.test(id);
}

export async function ensureCustomCodeLanguagesDir(): Promise<string> {
  const dir = getCustomCodeLanguagesDir();
  await fs.mkdir(dir, { recursive: true });
  const readme = path.join(dir, "README.md");
  // Exclusive create instead of exists-then-write: `wx` makes the filesystem
  // answer "already there" atomically, so nothing lands in the gap between a
  // check and the write, and an existing README is never overwritten.
  await fs.writeFile(readme, README, { flag: "wx" }).catch(() => {});
  return dir;
}

/**
 * Wall-clock ceiling for tokenizing the whole vetting corpus. A grammar that
 * cannot get through a few hundred short lines in two seconds will hang the
 * renderer on a real file, because the renderer tokenizes synchronously.
 */
const VET_TIMEOUT_MS = 2000;
export const SLOW_GRAMMAR_ERROR =
  "This language's grammar takes too long to highlight and was disabled.";

/**
 * Adversarial input for the vetting run. A TextMate grammar is regexes all the
 * way down, and Oniguruma will happily backtrack forever on a pattern like
 * `(a+)+Nz$`: what triggers it is not exotic source, it is a long run of one
 * repeated character that ultimately fails to match. So the corpus is mostly
 * runs, at the lengths where exponential backtracking stops being survivable.
 */
function buildVetCorpus(): string[][] {
  const sample = [
    "module vet",
    "",
    "// a comment",
    'let greeting = "hello"',
    "let answer = 42",
    "fn main() { print(greeting) }",
  ];
  const documents: string[][] = [sample];
  const runs = [
    "a",
    "z",
    "0",
    " ",
    "\t",
    "(",
    "*",
    "\\",
    '"',
    "/",
    "-",
    "_",
    "ab",
    "a1",
    "a ",
    "()",
  ];
  const lengths = [64, 128, 256, 512];
  for (const unit of runs) {
    for (const length of lengths) {
      const run = unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
      documents.push([run]);
      // The failing tail is the trigger: a run that matches all the way to the
      // end never backtracks, the same run followed by a character the pattern
      // rejects is what makes it explode.
      documents.push([`${run}!`]);
      documents.push([`  ${run}`]);
      documents.push([`"${run}`]);
      documents.push([`${run}"`]);
    }
  }
  documents.push([`identifier_${"x".repeat(500)}`]);
  documents.push([`${"nested(".repeat(64)}${")".repeat(64)}`]);
  return documents;
}

/**
 * Runs in a worker thread so a runaway grammar can be killed. `terminate()` is
 * the only lever that works here: the tokenizer is synchronous, and its own
 * time limit is checked between scans, which a single catastrophic match never
 * reaches. Written as a source string rather than a second entry point because
 * the main process is bundled and a new chunk would need build wiring.
 */
const VET_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const textmate = require(workerData.textmatePath)
const oniguruma = require(workerData.onigPath)

async function run() {
  await oniguruma.loadWASM(workerData.wasm)
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: oniguruma.createOnigScanner,
      createOnigString: oniguruma.createOnigString
    }),
    loadGrammar: async (scope) =>
      scope === workerData.scopeName
        ? textmate.parseRawGrammar(workerData.grammar, 'vet.tmLanguage.json')
        : null
  })
  const grammar = await registry.loadGrammar(workerData.scopeName)
  if (!grammar) return
  for (const document of workerData.documents) {
    let state = textmate.INITIAL
    for (const line of document) {
      state = grammar.tokenizeLine(line, state, 100).ruleStack
    }
  }
}

run().then(
  () => parentPort.postMessage({ ok: true }),
  // A grammar that throws is a correctness problem the renderer already
  // handles by leaving the fence plain. Only slowness is disqualifying here.
  () => parentPort.postMessage({ ok: true })
)
`;

const requireFromMain = createRequire(import.meta.url);
let vetRuntime: {
  textmatePath: string;
  onigPath: string;
  wasm: Buffer;
} | null = null;
let vetRuntimeFailed = false;

function loadVetRuntime(): typeof vetRuntime {
  if (vetRuntime || vetRuntimeFailed) return vetRuntime;
  try {
    vetRuntime = {
      textmatePath: requireFromMain.resolve("vscode-textmate"),
      onigPath: requireFromMain.resolve("vscode-oniguruma"),
      wasm: fsSync.readFileSync(
        requireFromMain.resolve("vscode-oniguruma/release/onig.wasm"),
      ),
    };
  } catch (error) {
    // No engine to vet with. Fail open: refusing every grammar because the
    // checker is missing would be a worse bug than the one it guards against,
    // and the renderer quarantines a slow grammar on first use anyway.
    vetRuntimeFailed = true;
    console.warn("[zen] grammar vetting is unavailable:", error);
  }
  return vetRuntime;
}

function runVetWorker(
  grammar: string,
  scopeName: string,
  timeoutMs: number,
): Promise<boolean> {
  const runtime = loadVetRuntime();
  if (!runtime) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(VET_WORKER_SOURCE, {
        eval: true,
        workerData: {
          textmatePath: runtime.textmatePath,
          onigPath: runtime.onigPath,
          wasm: runtime.wasm,
          grammar,
          scopeName,
          documents: buildVetCorpus(),
        },
      });
    } catch (error) {
      console.warn("[zen] could not start the grammar vetting worker:", error);
      resolve(true);
      return;
    }
    // The worker must never hold the app open; the timer below is what keeps
    // the event loop alive long enough for a verdict.
    worker.unref();
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    worker.once("message", () => finish(true));
    worker.once("error", (error) => {
      console.warn("[zen] grammar vetting failed:", error);
      finish(true);
    });
    worker.once("exit", () => finish(true));
  });
}

interface VetCacheFile {
  version: 1;
  verdicts: Record<string, { ok: boolean; at: number }>;
}

const VET_CACHE_LIMIT = 64;
let vetCache: VetCacheFile | null = null;

/**
 * Lives beside the config rather than inside `languages/`, because that folder
 * is watched and writing into it would fire a reload on every verdict.
 */
function vetCacheFile(): string {
  return path.join(getConfigDir(), "language-vet-cache.json");
}

async function readVetCache(): Promise<VetCacheFile> {
  if (vetCache) return vetCache;
  try {
    const parsed = JSON.parse(
      await fs.readFile(vetCacheFile(), "utf8"),
    ) as Partial<VetCacheFile>;
    if (
      parsed.version === 1 &&
      parsed.verdicts &&
      typeof parsed.verdicts === "object"
    ) {
      vetCache = { version: 1, verdicts: parsed.verdicts };
      return vetCache;
    }
  } catch {
    // No cache yet, or one written by a future schema.
  }
  vetCache = { version: 1, verdicts: {} };
  return vetCache;
}

async function writeVetCache(cache: VetCacheFile): Promise<void> {
  const entries = Object.entries(cache.verdicts).sort(
    (a, b) => b[1].at - a[1].at,
  );
  cache.verdicts = Object.fromEntries(entries.slice(0, VET_CACHE_LIMIT));
  const file = vetCacheFile();
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temp, `${JSON.stringify(cache, null, 2)}\n`);
    await fs.rename(temp, file);
  } catch {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * True when this grammar is safe to hand to the renderer. Keyed by grammar
 * content, so a verdict is reached once per distinct file and every later load
 * is a map lookup rather than a two-second tax on boot.
 */
export async function isGrammarFastEnough(
  grammar: string,
  scopeName: string,
  timeoutMs = VET_TIMEOUT_MS,
): Promise<boolean> {
  const key = createHash("sha256").update(grammar).digest("hex");
  const cache = await readVetCache();
  const cached = cache.verdicts[key];
  if (cached) return cached.ok;
  // A settings change and a watcher event can both be listing at once; without
  // this they would each spawn a worker and each wait out the same timeout.
  const running = vetsInFlight.get(key);
  if (running) return running;
  const pending = runVetWorker(grammar, scopeName, timeoutMs)
    .then(async (ok) => {
      cache.verdicts[key] = { ok, at: Date.now() };
      await writeVetCache(cache);
      return ok;
    })
    .finally(() => vetsInFlight.delete(key));
  vetsInFlight.set(key, pending);
  return pending;
}

const vetsInFlight = new Map<string, Promise<boolean>>();

/**
 * Parsed grammars by file identity. Every settings change re-lists, and the
 * parse walks the whole pattern tree looking for external includes, so an
 * enable/disable toggle used to re-parse every installed grammar.
 */
const parsedGrammarCache = new Map<
  string,
  { key: string; scopeName: string }
>();

async function parseGrammarCached(
  file: string,
): Promise<{ text: string; scopeName: string }> {
  const stats = await fs.stat(file);
  const key = `${stats.mtimeMs}\0${stats.size}`;
  const text = await fs.readFile(file, "utf8");
  const cached = parsedGrammarCache.get(file);
  if (cached?.key === key) return { text, scopeName: cached.scopeName };
  const { scopeName } = parseTextMateGrammar(text);
  parsedGrammarCache.set(file, { key, scopeName });
  return { text, scopeName };
}

export async function listCustomCodeLanguages(): Promise<CustomCodeLanguage[]> {
  const dir = getCustomCodeLanguagesDir();
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: CustomCodeLanguage[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith(".") ||
      !isSafeId(entry.name)
    )
      continue;
    const fallback: CustomCodeLanguage = {
      schemaVersion: 1,
      id: entry.name,
      name: entry.name,
      aliases: [entry.name],
      scopeName: `source.${entry.name}`,
      enabled: false,
      grammar: "",
    };
    try {
      const folder = path.join(dir, entry.name);
      const [manifestText, parsedGrammar] = await Promise.all([
        fs.readFile(path.join(folder, "manifest.json"), "utf8"),
        parseGrammarCached(path.join(folder, "grammar.tmLanguage.json")),
      ]);
      const grammar = parsedGrammar.text;
      const rawManifest = JSON.parse(
        manifestText,
      ) as Partial<CustomCodeLanguageManifest>;
      const manifest = validateCustomCodeLanguageManifest(
        {
          id: String(rawManifest.id ?? entry.name),
          name: String(rawManifest.name ?? entry.name),
          aliases: Array.isArray(rawManifest.aliases)
            ? rawManifest.aliases.filter(
                (value): value is string => typeof value === "string",
              )
            : [entry.name],
          scopeName: parsedGrammar.scopeName,
          enabled: rawManifest.enabled !== false,
        },
        { reservedAliases: RESERVED_CODE_FENCE_TAGS },
      );
      if (manifest.id !== entry.name)
        throw new Error("The manifest id must match its folder name.");
      // Folders can also arrive by hand, so the timing check is repeated here
      // rather than trusted from install. It is a cache lookup after the first
      // time a given grammar file is seen.
      if (!(await isGrammarFastEnough(grammar, manifest.scopeName))) {
        result.push({
          ...manifest,
          enabled: false,
          grammar: "",
          error: SLOW_GRAMMAR_ERROR,
        });
        continue;
      }
      result.push({ ...manifest, grammar });
    } catch (error) {
      result.push({
        ...fallback,
        error:
          error instanceof Error
            ? error.message
            : "This language could not be loaded.",
      });
    }
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export async function installCustomCodeLanguage(
  input: CustomCodeLanguageInstallInput,
): Promise<CustomCodeLanguage> {
  const dir = await ensureCustomCodeLanguagesDir();
  const parsed = parseTextMateGrammar(input.grammar);
  if (!(await isGrammarFastEnough(input.grammar, parsed.scopeName))) {
    throw new Error(SLOW_GRAMMAR_ERROR);
  }
  const existing = await listCustomCodeLanguages();
  // Ids on disk are normalized, so an unnormalized one over IPC ("Gleam")
  // would otherwise miss the replace guard and skip the backup/rollback branch
  // while `manifest.id` still resolved to the same folder.
  const id = normalizeCodeFenceTag(input.id);
  const targetExists = existing.some((language) => language.id === id);
  if (targetExists && !input.replace)
    throw new Error(`A language with id “${id}” already exists.`);
  const manifest = validateCustomCodeLanguageManifest(
    {
      id,
      name: input.name,
      aliases: input.aliases,
      scopeName: parsed.scopeName,
      enabled: input.enabled !== false,
    },
    {
      reservedAliases: RESERVED_CODE_FENCE_TAGS,
      existing,
      replacingId: targetExists ? id : undefined,
    },
  );
  const target = path.join(dir, manifest.id);
  const stage = path.join(dir, `.${manifest.id}-${randomUUID()}.tmp`);
  const backup = path.join(dir, `.${manifest.id}-${randomUUID()}.bak`);
  await fs.mkdir(stage, { recursive: false });
  try {
    await Promise.all([
      fs.writeFile(
        path.join(stage, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      ),
      fs.writeFile(path.join(stage, "grammar.tmLanguage.json"), input.grammar),
    ]);
    if (targetExists) await fs.rename(target, backup);
    try {
      await fs.rename(stage, target);
    } catch (error) {
      if (targetExists) await fs.rename(backup, target).catch(() => {});
      throw error;
    }
    if (targetExists) await fs.rm(backup, { recursive: true, force: true });
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
  return { ...manifest, grammar: input.grammar };
}

export async function updateCustomCodeLanguage(
  input: CustomCodeLanguageUpdateInput,
): Promise<CustomCodeLanguage> {
  if (!isSafeId(input.id)) throw new Error("Invalid custom language id.");
  const languages = await listCustomCodeLanguages();
  const current = languages.find((language) => language.id === input.id);
  if (!current || current.error)
    throw new Error(`Custom language “${input.id}” is not available.`);
  const manifest = validateCustomCodeLanguageManifest(
    {
      id: current.id,
      name: input.name ?? current.name,
      aliases: input.aliases ?? current.aliases,
      scopeName: current.scopeName,
      enabled: input.enabled ?? current.enabled,
    },
    {
      reservedAliases: RESERVED_CODE_FENCE_TAGS,
      existing: languages,
      replacingId: current.id,
    },
  );
  const file = path.join(
    getCustomCodeLanguagesDir(),
    current.id,
    "manifest.json",
  );
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.rename(temp, file);
  return { ...manifest, grammar: current.grammar };
}

export async function deleteCustomCodeLanguage(id: string): Promise<void> {
  if (!isSafeId(id)) return;
  const dir = getCustomCodeLanguagesDir();
  const folder = path.join(dir, id);
  if (path.dirname(path.resolve(folder)) !== path.resolve(dir)) return;
  await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
}

export async function customCodeLanguageRevealTarget(
  id?: string,
): Promise<string> {
  const dir = await ensureCustomCodeLanguagesDir();
  if (isSafeId(id)) {
    const grammar = path.join(dir, id, "grammar.tmLanguage.json");
    if (
      path.dirname(path.dirname(path.resolve(grammar))) === path.resolve(dir) &&
      fsSync.existsSync(grammar)
    ) {
      return grammar;
    }
  }
  return dir;
}

let watcher: ReturnType<typeof chokidar.watch> | null = null;

export function startWatchingCustomCodeLanguages(
  onChange: (languages: CustomCodeLanguage[]) => void,
): void {
  void watcher?.close();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void listCustomCodeLanguages().then(onChange);
    }, 200);
  };
  watcher = chokidar.watch(getCustomCodeLanguagesDir(), {
    ignoreInitial: true,
    depth: 1,
    // A pack folder the app cannot read costs that folder, not the watcher.
    ignorePermissionErrors: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  watcher
    .on("add", fire)
    .on("change", fire)
    .on("unlink", fire)
    .on("addDir", fire)
    .on("unlinkDir", fire)
    // With no listener, chokidar's 'error' rejects inside its own scan and
    // the watcher stops reporting edits for the rest of the session.
    .on("error", (error) =>
      console.warn("[zen] the language packs watcher could not watch a path:", error),
    );
}

/** Test/teardown hook: stop the language packs watcher. */
export async function stopWatchingCustomCodeLanguages(): Promise<void> {
  await watcher?.close().catch(() => {});
  watcher = null;
}

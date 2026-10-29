/** Registry and UI token mapping shared by custom-language editor and preview highlighting. */
import {
  normalizeCodeFenceTag,
  type CustomCodeLanguage,
} from "@shared/custom-code-languages";
import type { EngineLoadedLanguage } from "./custom-code-language-engine";

export type CodeTokenKind =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "atom"
  | "operator"
  | "type"
  | "tag"
  | "function"
  | "variable"
  | "property"
  | "punctuation"
  | "attribute"
  | "meta"
  | "invalid";

export interface CodeHighlightToken {
  from: number;
  to: number;
  kind: CodeTokenKind;
}

type CustomCodeLanguageEngine = typeof import("./custom-code-language-engine");

const MAX_BLOCK_CHARS = 200_000;
const TOKEN_CACHE_LIMIT = 48;

class CustomCodeLanguageRegistry {
  private byAlias = new Map<string, EngineLoadedLanguage>();
  private engine: CustomCodeLanguageEngine | null = null;
  private listeners = new Set<() => void>();
  private generation = 0;
  private cache = new Map<string, CodeHighlightToken[]>();
  private quarantined = new Map<string, string>();
  revision = 0;

  /**
   * Never rejects. Both callers fire this and walk away (`void applyCustom…`),
   * so a failing dynamic import or a dead WASM engine has to end as "no custom
   * languages" rather than as an unhandled rejection on every settings change.
   */
  async replace(definitions: readonly CustomCodeLanguage[]): Promise<void> {
    const generation = ++this.generation;
    const hasEnabledLanguage = definitions.some(
      (definition) =>
        definition.enabled && !definition.error && !!definition.grammar,
    );
    let engine: CustomCodeLanguageEngine | null = null;
    let next = new Map<string, EngineLoadedLanguage>();
    try {
      if (hasEnabledLanguage) {
        engine = await import("./custom-code-language-engine");
        next = await engine.buildTextMateRegistry(definitions);
      }
    } catch (error) {
      engine = null;
      next = new Map();
      console.warn("[zen] could not load custom code languages:", error);
    }
    if (generation !== this.generation) return;
    this.byAlias = next;
    this.engine = engine;
    this.cache.clear();
    this.quarantined.clear();
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  /**
   * Why a language stopped highlighting mid-session, for Settings to show.
   * Mirrored off the engine so the UI can ask without pulling the TextMate
   * bundle into the entry chunk.
   */
  quarantineReason(id: string): string | null {
    return this.quarantined.get(id) ?? null;
  }

  /** True when no language is installed and enabled, i.e. nothing here can
   *  ever match a fence tag. Lets callers skip work entirely, which is the
   *  common case: most vaults never install a grammar. */
  get isEmpty(): boolean {
    return this.byAlias.size === 0;
  }

  resolve(tag: string): EngineLoadedLanguage | null {
    return this.byAlias.get(normalizeCodeFenceTag(tag)) ?? null;
  }

  /** Every installed language that highlights right now, once each, with the
   *  fence tags it answers to (the code block language picker lists them). */
  languages(): Array<{ id: string; name: string; aliases: string[] }> {
    const byId = new Map<string, { id: string; name: string; aliases: string[] }>();
    for (const [alias, loaded] of this.byAlias) {
      const { id, name, aliases } = loaded.definition;
      let entry = byId.get(id);
      if (!entry) {
        // The definition's own order first, so its first alias is the tag a
        // pick writes; then any alias the registry holds beyond those.
        entry = { id, name, aliases: aliases.map(normalizeCodeFenceTag) };
        byId.set(id, entry);
      }
      if (!entry.aliases.includes(alias)) entry.aliases.push(alias);
    }
    return [...byId.values()];
  }

  tokenize(tag: string, source: string): CodeHighlightToken[] {
    const loaded = this.resolve(tag);
    if (!loaded || !this.engine || !source || source.length > MAX_BLOCK_CHARS)
      return [];
    const key = `${this.revision}\0${loaded.definition.id}\0${source}`;
    const cached = this.cache.get(key);
    // Re-insert on hit so the map evicts least-recently-used, not
    // first-inserted: a note with more fences than the cap used to age out the
    // entry it was about to need and re-tokenize everything per keystroke.
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const tokens = this.engine.tokenizeWithGrammar(loaded, source);
    const reason = this.engine
      .quarantinedCustomLanguages()
      .get(loaded.definition.id);
    if (reason) {
      this.dropQuarantined(loaded.definition.id, reason);
      return tokens;
    }
    this.cache.set(key, tokens);
    while (this.cache.size > TOKEN_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (typeof oldest !== "string") break;
      this.cache.delete(oldest);
    }
    return tokens;
  }

  /**
   * Unhook every alias of a language the engine just gave up on, so the next
   * render treats its fences as plain text instead of paying the same stall
   * again. Listeners are notified off the current task because `tokenize` runs
   * inside a CodeMirror view update, which must not dispatch re-entrantly.
   */
  private dropQuarantined(id: string, reason: string): void {
    this.quarantined.set(id, reason);
    for (const [alias, loaded] of this.byAlias) {
      if (loaded.definition.id === id) this.byAlias.delete(alias);
    }
    this.cache.clear();
    // Bumping the revision is what evicts already-rendered Markdown for this
    // language from the HTML cache in `markdown.ts`.
    this.revision++;
    queueMicrotask(() => {
      for (const listener of this.listeners) listener();
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const customCodeLanguageRegistry = new CustomCodeLanguageRegistry();

export async function tokenizeCustomGrammarPreview(
  definition: CustomCodeLanguage,
  source: string,
): Promise<CodeHighlightToken[]> {
  const engine = await import("./custom-code-language-engine");
  const registry = await engine.buildTextMateRegistry(
    [{ ...definition, enabled: true, error: undefined }],
    true,
  );
  const loaded = registry.get(
    normalizeCodeFenceTag(definition.aliases[0] ?? definition.id),
  );
  return loaded ? engine.tokenizeWithGrammar(loaded, source) : [];
}

export const EDITOR_TOKEN_CLASS: Record<CodeTokenKind, string> = {
  keyword: "tok-keyword",
  string: "tok-string",
  comment: "tok-comment",
  number: "tok-number",
  atom: "tok-atom",
  operator: "tok-operator",
  type: "tok-type",
  tag: "tok-tag",
  function: "tok-function",
  variable: "tok-variable",
  property: "tok-property",
  punctuation: "tok-punct",
  attribute: "tok-attr",
  meta: "tok-meta-code",
  invalid: "tok-invalid",
};

export const PREVIEW_TOKEN_CLASS: Record<CodeTokenKind, string> = {
  keyword: "hljs-keyword",
  string: "hljs-string",
  comment: "hljs-comment",
  number: "hljs-number",
  atom: "hljs-literal",
  operator: "hljs-operator",
  type: "hljs-type",
  tag: "hljs-tag",
  function: "hljs-title function_",
  variable: "hljs-variable",
  property: "hljs-property",
  punctuation: "hljs-punctuation",
  attribute: "hljs-attr",
  meta: "hljs-meta",
  invalid: "hljs-deletion",
};

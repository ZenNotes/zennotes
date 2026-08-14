/** Lazy TextMate/Oniguruma engine. Loaded only when at least one custom language is enabled. */
import {
  INITIAL,
  Registry,
  parseRawGrammar,
  type IGrammar,
  type IRawGrammar,
  type StateStack,
} from "vscode-textmate";
import {
  createOnigScanner,
  createOnigString,
  loadWASM,
} from "vscode-oniguruma";
import onigWasmDataUrl from "vscode-oniguruma/release/onig.wasm?url";
import {
  normalizeCodeFenceTag,
  type CustomCodeLanguage,
} from "@shared/custom-code-languages";
import type {
  CodeHighlightToken,
  CodeTokenKind,
} from "./custom-code-languages";

export interface EngineLoadedLanguage {
  definition: CustomCodeLanguage;
  grammar: IGrammar;
}

/**
 * `tokenizeLine`'s own limit is only consulted *between* scans, so it cannot
 * bound the first match on a line: one catastrophically backtracking pattern
 * runs unbounded inside Oniguruma. It still cuts short a line that survives
 * many cheap scans, so it stays; the wall-clock budgets below are what actually
 * protect the frame.
 */
const LINE_TIME_LIMIT_MS = 20;
/** One line this slow has already dropped frames; nothing legitimate needs it. */
const LINE_BUDGET_MS = 100;
/** Whole-fence ceiling, so a thousand merely-slow lines cannot add up to a freeze. */
const FENCE_BUDGET_MS = 500;

let onigReady: Promise<void> | null = null;
let engineError: string | null = null;
const quarantined = new Map<string, string>();

/**
 * Why the engine has nothing to offer: the Oniguruma WASM failed to load. Kept
 * as queryable state instead of a rejected promise because every caller of
 * `buildTextMateRegistry` outside the import preview is fire-and-forget, and a
 * rejection there surfaces as an unhandled rejection on every grammar change.
 */
export function customCodeEngineError(): string | null {
  return engineError;
}

/**
 * Languages dropped mid-session for blowing the tokenize budget, by id, with
 * the reason to show in Settings. Survives until the next `replace`, so the
 * cost of a pathological grammar is paid once rather than on every keystroke.
 */
export function quarantinedCustomLanguages(): ReadonlyMap<string, string> {
  return quarantined;
}

function ensureOniguruma(): Promise<void> {
  if (!onigReady) {
    onigReady = (async () => {
      const marker = ';base64,';
      const markerIndex = onigWasmDataUrl.indexOf(marker);
      if (!onigWasmDataUrl.startsWith('data:application/wasm') || markerIndex < 0) {
        throw new Error('The embedded Oniguruma WASM is invalid.');
      }
      const binary = atob(onigWasmDataUrl.slice(markerIndex + marker.length));
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      await loadWASM(bytes);
    })().catch((error: unknown) => {
      // Drop the rejected promise so a transient failure is retried on the
      // next grammar change rather than cached as "the engine is dead".
      onigReady = null;
      throw error;
    });
  }
  return onigReady;
}

export async function buildTextMateRegistry(
  definitions: readonly CustomCodeLanguage[],
  throwOnLoadError = false,
): Promise<Map<string, EngineLoadedLanguage>> {
  quarantined.clear();
  const enabledDefinitions = definitions.filter(
    (definition) =>
      definition.enabled && !definition.error && !!definition.grammar,
  );
  if (enabledDefinitions.length === 0) return new Map();

  try {
    await ensureOniguruma();
    engineError = null;
  } catch (error) {
    engineError =
      error instanceof Error
        ? error.message
        : 'The syntax-highlighting engine could not start.';
    if (throwOnLoadError) throw error;
    console.warn('[zen] custom code languages are unavailable:', error);
    return new Map();
  }
  const rawByScope = new Map<string, IRawGrammar>();
  for (const definition of enabledDefinitions) {
    try {
      rawByScope.set(
        definition.scopeName,
        parseRawGrammar(definition.grammar, `${definition.id}.tmLanguage.json`),
      );
    } catch (error) {
      if (throwOnLoadError) throw error;
      // Hand-edited grammar that the main process has not re-validated yet.
    }
  }
  const registry = new Registry({
    onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
    loadGrammar: async (scopeName) => rawByScope.get(scopeName) ?? null,
  });
  const byAlias = new Map<string, EngineLoadedLanguage>();
  for (const definition of enabledDefinitions) {
    if (!rawByScope.has(definition.scopeName)) continue;
    try {
      const grammar = await registry.loadGrammar(definition.scopeName);
      if (!grammar) continue;
      const loaded = { definition, grammar };
      for (const alias of definition.aliases) {
        byAlias.set(normalizeCodeFenceTag(alias), loaded);
      }
    } catch (error) {
      if (throwOnLoadError) throw error;
      // A malformed runtime regex leaves this language plain-text. Structural
      // import failures are reported by the main process in Settings.
    }
  }
  return byAlias;
}

/**
 * Tokenize one fence, giving up the moment the grammar costs more time than a
 * frame can spare. This runs synchronously from `renderMarkdown` and from
 * CodeMirror's `buildDecorations`, so an unbounded run is a frozen window: the
 * budgets below are the only thing standing between a backtracking pattern and
 * a hang. Blowing them quarantines the language for the session, because the
 * same fence would otherwise be re-tokenized on the next keystroke.
 */
export function tokenizeWithGrammar(
  loaded: EngineLoadedLanguage,
  source: string,
): CodeHighlightToken[] {
  const { grammar, definition } = loaded;
  const output: CodeHighlightToken[] = [];
  let lineOffset = 0;
  let spent = 0;
  let state: StateStack | null = INITIAL;
  const lines = source.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    let started = performance.now();
    let result = grammar.tokenizeLine(line, state, LINE_TIME_LIMIT_MS);
    let elapsed = performance.now() - started;
    spent += elapsed;
    if (elapsed > LINE_BUDGET_MS || spent > FENCE_BUDGET_MS) {
      quarantine(definition.id, definition.name);
      return [];
    }
    // TextMate charges one-time scanner compilation against the first line's
    // limit. A busy Windows host can exhaust that limit before scanning even a
    // tiny line. Retry that first line once now that the scanner is compiled.
    if (lineIndex === 0 && result.stoppedEarly) {
      started = performance.now();
      result = grammar.tokenizeLine(line, state, LINE_TIME_LIMIT_MS);
      elapsed = performance.now() - started;
      spent += elapsed;
      if (elapsed > LINE_BUDGET_MS || spent > FENCE_BUDGET_MS) {
        quarantine(definition.id, definition.name);
        return [];
      }
    }
    if (result.stoppedEarly) return [];
    state = result.ruleStack;
    for (const token of result.tokens) {
      const kind = kindForScopes(token.scopes);
      if (!kind || token.endIndex <= token.startIndex) continue;
      pushMerged(output, {
        from: lineOffset + token.startIndex,
        to: lineOffset + Math.min(token.endIndex, line.length),
        kind,
      });
    }
    lineOffset += line.length + (lineIndex < lines.length - 1 ? 1 : 0);
  }
  return output;
}

function quarantine(id: string, name: string): void {
  if (quarantined.has(id)) return;
  quarantined.set(
    id,
    "This language's grammar is too slow to highlight and was turned off for this session.",
  );
  console.warn(
    `[zen] custom code language “${name}” exceeded its highlighting budget and was disabled for this session.`,
  );
}

function pushMerged(
  tokens: CodeHighlightToken[],
  next: CodeHighlightToken,
): void {
  const previous = tokens[tokens.length - 1];
  if (previous && previous.kind === next.kind && previous.to === next.from) {
    previous.to = next.to;
  } else {
    tokens.push(next);
  }
}

function kindForScopes(scopes: readonly string[]): CodeTokenKind | null {
  const scope = scopes.join(" ").toLowerCase();
  if (/invalid|illegal/.test(scope)) return "invalid";
  if (/comment/.test(scope)) return "comment";
  if (/string|regexp|quoted/.test(scope)) return "string";
  if (/constant\.numeric|\bnumber\b/.test(scope)) return "number";
  if (/constant\.language|constant\.character|support\.constant/.test(scope)) {
    return "atom";
  }
  if (/keyword|storage\.(?:type|modifier)/.test(scope)) return "keyword";
  if (
    /entity\.name\.(?:class|type|namespace)|support\.(?:class|type)/.test(scope)
  ) {
    return "type";
  }
  if (/entity\.name\.function|support\.function/.test(scope)) return "function";
  if (/entity\.name\.tag/.test(scope)) return "tag";
  if (/entity\.other\.attribute-name/.test(scope)) return "attribute";
  if (
    /variable\.other\.(?:property|member)|meta\.object-literal\.key/.test(scope)
  ) {
    return "property";
  }
  if (/variable|entity\.name\.variable/.test(scope)) return "variable";
  if (/keyword\.operator|\boperator\b/.test(scope)) return "operator";
  if (/punctuation/.test(scope)) return "punctuation";
  if (/meta\.|entity\.name\.section/.test(scope)) return "meta";
  return null;
}

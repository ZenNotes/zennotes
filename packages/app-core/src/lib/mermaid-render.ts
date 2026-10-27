/**
 * Mermaid diagrams, shared by every surface that draws one: the Preview
 * pipeline and the editor's live preview.
 *
 * A ```mermaid fence is drawn by Pele (pele.run), which reads Mermaid syntax
 * with parsers of its own and lays the diagram out itself, returning one
 * self-contained SVG string. It replaced mermaid.js: the syntax notes already
 * hold keeps working, while the drawing is synchronous, a fraction of the size,
 * and labels are SVG text rather than HTML inside `foreignObject`, which is the
 * layer every clipped-label bug here came from (#529, #911). The one exception
 * is `$$…$$` math in a label, typeset as MathML by `mermaid-label-math`, which
 * measures each formula itself so its box fits.
 *
 * It lives here rather than beside either caller because a second copy of the
 * render options is a second answer to "what does this diagram look like", and
 * this codebase has already paid for duplicated rendering rules more than once.
 * The lazy import is a singleton for the same reason the chunk is lazy at all:
 * diagrams must stay off the boot path, so nothing here runs until a note
 * actually contains a mermaid fence.
 *
 * Colour is not decided here. The SVG paints through `--pele-*` variables that
 * `index.css` maps onto the app theme, so one drawing is right in every theme
 * and a theme switch repaints without drawing again. Only the fonts change the
 * layout, because Pele measures every label to size its box, so they are the
 * only theme input in the cache key.
 */

type PeleRuntime = typeof import("./pele-runtime");

let runtime: PeleRuntime | null = null;
let runtimePromise: Promise<PeleRuntime> | null = null;

function loadPele(): Promise<PeleRuntime> {
  if (!runtimePromise) {
    runtimePromise = import("./pele-runtime").then((module) => {
      runtime = module;
      return module;
    });
  }
  return runtimePromise;
}

/** The stack `.prose-zen` falls back to when no text font is configured.
 *  Kept byte-identical to the `--z-text-font` fallback in index.css: labels are
 *  measured against whatever this says, so a drift here reintroduces the
 *  clipped labels this helper exists to prevent (#529). */
const PROSE_FONT_FALLBACK =
  '"SF Mono", "SFMono-Regular", ui-monospace, "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** The code font's fallback, as `index.css` spells it for `--z-mono-font`. */
const MONO_FONT_FALLBACK = '"SF Mono", ui-monospace, monospace';

/** Matches the 14px the diagrams were drawn at before Pele, so a note's
 *  diagrams keep their scale next to its text. */
const DIAGRAM_FONT_SIZE = 14;

/** Read a `--z-*` CSS font variable as a concrete font-family string. Pele
 *  measures labels on a canvas, which knows nothing of `inherit`, and writes the
 *  same family into the SVG it returns, so the label is painted in exactly the
 *  font it was measured in. */
function readThemeFont(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return raw || fallback;
}

interface DiagramFonts {
  text: string;
  mono: string;
}

function currentFonts(): DiagramFonts {
  return {
    text: readThemeFont("--z-text-font", PROSE_FONT_FALLBACK),
    mono: readThemeFont("--z-mono-font", MONO_FONT_FALLBACK),
  };
}

/** Labels measured against a font that is still loading come back sized for
 *  the fallback and clip once the real font paints, so a drawing only happens
 *  synchronously when nothing is loading, and an async one waits. */
function fontsSettled(): boolean {
  return typeof document === "undefined" || !document.fonts || document.fonts.status === "loaded";
}

async function waitForFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  try {
    await document.fonts.ready;
  } catch {
    /* ignore font-api failures and render anyway */
  }
}

/* -------------------------------------------------------------------------- */
/*  Rendered SVG, cached                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One entry per (fonts, source). Keyed by the diagram text itself, so an editor
 * that re-renders on every keystroke pays for a diagram once and a cursor
 * moving in and out of a block costs nothing at all. The SVG carries no ids
 * (beyond an accessibility title, which gets a fresh prefix per drawing) and no
 * palette, so the editor and Preview can show the same string side by side.
 */
const svgCache = new Map<string, MermaidRenderResult>();
const inFlight = new Map<string, Promise<MermaidRenderResult>>();

/** Bounded so a long editing session cannot grow it without limit. Diagrams are
 *  big strings; the number is small on purpose. */
const SVG_CACHE_LIMIT = 60;

export type MermaidRenderResult = { ok: true; svg: string } | { ok: false; error: string };

function cacheKey(source: string, fonts: DiagramFonts): string {
  return `${fonts.text}\u0000${fonts.mono}\u0000${source}`;
}

/** The two surfaces read one fence differently: Preview keeps the code
 *  block's trailing newline, the editor widget trims the body. Unnormalized,
 *  split view drew every diagram twice under two keys, which is the double
 *  work the shared cache exists to remove (#184). Whitespace around a diagram
 *  never changes it. */
function normalizeSource(source: string): string {
  return source.trim();
}

function remember(key: string, result: MermaidRenderResult): MermaidRenderResult {
  if (svgCache.size >= SVG_CACHE_LIMIT) {
    const oldest = svgCache.keys().next().value;
    if (oldest !== undefined) svgCache.delete(oldest);
  }
  svgCache.set(key, result);
  return result;
}

let renderSeq = 0;

function renderOptions(pele: PeleRuntime, fonts: DiagramFonts, idPrefix: string) {
  return {
    math: pele.typesetLabelMath,
    fontFamily: fonts.text,
    fontFamilyMono: fonts.mono,
    fontSize: DIAGRAM_FONT_SIZE,
    // Only an accessibility title or description carries an id; a fresh prefix
    // keeps two diagrams on one page from claiming the same one.
    idPrefix: `${idPrefix}-${renderSeq++}`,
    // A note is local-first and a diagram is a picture: drawing one never
    // fetches an image URL and never navigates. Mermaid ran in its strict mode
    // here, which turned off the same two things.
    images: false,
    links: false,
  };
}

function failure(error: unknown): MermaidRenderResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** A finished render, or null when this diagram cannot be painted right now.
 *  Lets a widget paint synchronously on re-mount instead of flashing empty.
 *  Once Pele and this diagram's type have loaded, a diagram that was never
 *  drawn is drawn here on the spot: rendering is synchronous and takes about a
 *  millisecond, so typing a new diagram never shows a pending block. */
export function peekMermaidSvg(rawSource: string, idPrefix = "zen-mermaid-live"): MermaidRenderResult | null {
  const source = normalizeSource(rawSource);
  const fonts = currentFonts();
  const key = cacheKey(source, fonts);
  const cached = svgCache.get(key);
  if (cached) return cached;
  if (!runtime || !fontsSettled() || !runtime.supports(source)) return null;
  try {
    return remember(key, { ok: true, svg: runtime.render(source, renderOptions(runtime, fonts, idPrefix)).svg });
  } catch (error) {
    return remember(key, failure(error));
  }
}

/** Render to an SVG string, reusing an in-flight render of the same diagram.
 *  Never throws: a broken diagram is a result the caller can show, and its
 *  message (which quotes the diagram source) must be shown as text. */
export function renderMermaidSvg(
  rawSource: string,
  idPrefix = "zen-mermaid-live",
): Promise<MermaidRenderResult> {
  const source = normalizeSource(rawSource);
  const peeked = peekMermaidSvg(source, idPrefix);
  if (peeked) return Promise.resolve(peeked);
  const fonts = currentFonts();
  const key = cacheKey(source, fonts);
  const running = inFlight.get(key);
  if (running) return running;

  const task = (async (): Promise<MermaidRenderResult> => {
    try {
      const [pele] = await Promise.all([loadPele(), waitForFonts()]);
      const { svg } = await pele.renderAsync(source, renderOptions(pele, fonts, idPrefix));
      return { ok: true, svg };
    } catch (error) {
      return failure(error);
    }
  })();

  inFlight.set(key, task);
  return task.then((result) => {
    inFlight.delete(key);
    return remember(key, result);
  });
}

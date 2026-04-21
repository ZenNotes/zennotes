/**
 * Client-side render loop for the three "math diagram" block types:
 * TikZ, JSXGraph, and function-plot.
 *
 * Preview.tsx calls `renderDiagrams(rootEl, { themeKey })` after each
 * markdown render (and again when the theme changes). Each function
 * below is a no-op when the root has no blocks of its type, so
 * loading a diagram library is pay-for-what-you-use: opening a note
 * without any JSXGraph fences never imports `jsxgraph`.
 *
 * Every library is loaded once, lazily, and memoized.
 */

function prepareDiagramShell(
  el: HTMLElement,
  kind: "tikz" | "jsxgraph" | "function-plot",
  source: string,
): HTMLDivElement {
  const expanded = el.dataset.zenDiagramExpanded === "true";
  el.dataset.zenDiagramKind = kind;
  el.dataset.zenDiagramSource = source;
  el.innerHTML = "";

  if (!expanded) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "zen-diagram-expand";
    button.setAttribute("aria-label", "Open diagram in a larger view");
    button.textContent = "Expand";
    el.appendChild(button);
  }

  const surface = document.createElement("div");
  surface.className = expanded
    ? "zen-diagram-surface zen-diagram-surface-expanded"
    : "zen-diagram-surface";
  el.appendChild(surface);
  return surface;
}

function normalizeSvgColor(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return trimmed;
}

function replaceSvgPaint(
  value: string,
  replacements: ReadonlyMap<string, string>,
): string | null {
  const normalized = normalizeSvgColor(value);
  if (
    !normalized ||
    normalized === "none" ||
    normalized === "currentcolor" ||
    normalized.startsWith("url(") ||
    normalized.startsWith("var(")
  ) {
    return null;
  }
  return replacements.get(normalized) ?? null;
}

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

function parseHexColor(value: string): RgbColor | null {
  const normalized = normalizeSvgColor(value);
  const match = normalized.match(/^#([0-9a-f]{6})$/);
  if (!match) return null;
  const hex = match[1];
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function rgbToHex(color: RgbColor): string {
  const hex = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
}

function srgbChannelToLinear(n: number): number {
  const unit = n / 255;
  return unit <= 0.04045 ? unit / 12.92 : Math.pow((unit + 0.055) / 1.055, 2.4);
}

function relativeLuminance(color: RgbColor): number {
  const r = srgbChannelToLinear(color.r);
  const g = srgbChannelToLinear(color.g);
  const b = srgbChannelToLinear(color.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgbToHue(color: RgbColor): number {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  if (max === r) return ((g - b) / delta + (g < b ? 6 : 0)) * 60;
  if (max === g) return ((b - r) / delta + 2) * 60;
  return ((r - g) / delta + 4) * 60;
}

function saturation(color: RgbColor): number {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const lightness = (max + min) / 2;
  const delta = max - min;
  return delta / (1 - Math.abs(2 * lightness - 1));
}

function mixColors(
  base: RgbColor,
  tint: RgbColor,
  tintAmount: number,
): RgbColor {
  const amount = Math.max(0, Math.min(1, tintAmount));
  return {
    r: base.r * (1 - amount) + tint.r * amount,
    g: base.g * (1 - amount) + tint.g * amount,
    b: base.b * (1 - amount) + tint.b * amount,
  };
}

function isDarkThemeSurface(): boolean {
  const bg = parseHexColor(themeColor("--z-bg", "#ffffff"));
  return bg ? relativeLuminance(bg) < 0.22 : false;
}

function themeRgb(cssVar: string, fallback: string): RgbColor {
  return (
    parseHexColor(themeColor(cssVar, fallback)) ?? parseHexColor(fallback)!
  );
}

function pickThemeTintForColor(color: RgbColor): RgbColor {
  const sat = saturation(color);
  if (sat < 0.08) return themeRgb("--z-grey-1", "#7c7c80");

  const hue = rgbToHue(color);
  if (hue < 20) return themeRgb("--z-red", "#ff453a");
  if (hue < 55) return themeRgb("--z-accent", "#ff9f0a");
  if (hue < 85) return themeRgb("--z-yellow", "#ffd60a");
  if (hue < 160) return themeRgb("--z-green", "#30d158");
  if (hue < 210) return themeRgb("--z-aqua", "#64d2ff");
  if (hue < 255) return themeRgb("--z-blue", "#0a84ff");
  if (hue < 330) return themeRgb("--z-purple", "#bf5af2");
  return themeRgb("--z-red", "#ff453a");
}

function adaptLightTikzFill(value: string): string | null {
  if (!isDarkThemeSurface()) return null;

  const source = parseHexColor(value);
  if (!source) return null;
  if (relativeLuminance(source) < 0.62) return null;

  const bg = themeRgb("--z-bg", "#282828");
  const tint = pickThemeTintForColor(source);
  const sat = saturation(source);
  const tintAmount = sat < 0.12 ? 0.2 : sat < 0.28 ? 0.28 : 0.36;
  return rgbToHex(mixColors(bg, tint, tintAmount));
}

function buildTikzColorReplacements(): Map<string, string> {
  const grey = themeColor("--z-grey-2", "#8e8e93");
  const mutedGrey = themeColor("--z-grey-1", "#7c7c80");
  const blue = themeColor("--z-blue", "#0a84ff");
  const red = themeColor("--z-red", "#ff453a");
  const green = themeColor("--z-green", "#30d158");
  const yellow = themeColor("--z-yellow", "#ffd60a");
  const accent = themeColor("--z-accent", "#ff9f0a");
  const purple = themeColor("--z-purple", "#bf5af2");
  const aqua = themeColor("--z-aqua", "#64d2ff");

  return new Map([
    ["#000000", "currentColor"],
    ["black", "currentColor"],
    ["#808080", grey],
    ["gray", grey],
    ["grey", grey],
    ["#a9a9a9", mutedGrey],
    ["darkgray", mutedGrey],
    ["darkgrey", mutedGrey],
    ["#d3d3d3", "currentColor"],
    ["lightgray", "currentColor"],
    ["lightgrey", "currentColor"],
    ["#0000ff", blue],
    ["blue", blue],
    ["#ff0000", red],
    ["red", red],
    ["#008000", green],
    ["green", green],
    ["#ffff00", yellow],
    ["yellow", yellow],
    ["#ffa500", accent],
    ["orange", accent],
    ["#800080", purple],
    ["purple", purple],
    ["#ff00ff", purple],
    ["magenta", purple],
    ["#00ffff", aqua],
    ["cyan", aqua],
    ["#008080", aqua],
    ["teal", aqua],
    ["aqua", aqua],
  ]);
}

function inheritsExplicitFill(node: Element): boolean {
  let ancestor: Element | null = node.parentElement;
  while (ancestor) {
    const fill = ancestor.getAttribute("fill");
    if (fill && fill.toLowerCase() !== "none") return true;

    const style = ancestor.getAttribute("style");
    if (style) {
      const match = style.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i);
      if (match && normalizeSvgColor(match[1]) !== "none") return true;
    }
    ancestor = ancestor.parentElement;
  }
  return false;
}

function tintTikzSvg(surface: HTMLElement): void {
  const replacements = buildTikzColorReplacements();
  const nodes = Array.from(surface.querySelectorAll<SVGElement>("svg, svg *"));

  for (const node of nodes) {
    for (const attr of ["stroke", "fill", "color"] as const) {
      const raw = node.getAttribute(attr);
      if (!raw) continue;
      const replacement =
        replaceSvgPaint(raw, replacements) ??
        (attr === "fill" ? adaptLightTikzFill(raw) : null);
      if (replacement) node.setAttribute(attr, replacement);
    }

    const style = node.getAttribute("style");
    if (style) {
      const rewritten = style.replace(
        /((?:^|;)\s*(?:fill|stroke|color)\s*:\s*)([^;]+)/gi,
        (match, prefix: string, raw: string) => {
          const replacement =
            replaceSvgPaint(raw, replacements) ??
            (/fill/i.test(prefix) ? adaptLightTikzFill(raw) : null);
          return replacement ? `${prefix}${replacement}` : match;
        },
      );
      if (rewritten !== style) node.setAttribute("style", rewritten);
    }
  }

  // Some TikZ output relies on SVG's default fill (black) instead of
  // emitting an explicit `fill` attribute. That is fine on light themes
  // but disappears into dark backgrounds. Patch only nodes that do not
  // already inherit a deliberate fill from an ancestor group.
  for (const node of Array.from(
    surface.querySelectorAll<SVGElement>(
      "text, path, circle, ellipse, polygon, rect",
    ),
  )) {
    if (node.hasAttribute("fill")) continue;
    if (inheritsExplicitFill(node)) continue;
    node.setAttribute("fill", "currentColor");
  }
}

// ---------------------------------------------------------------------------
// TikZ — main-process-compiled SVG
// ---------------------------------------------------------------------------

async function renderTikzBlock(el: HTMLElement): Promise<void> {
  const source =
    el.getAttribute("data-tikz-source") ?? el.textContent?.trim() ?? "";
  if (!source) return;
  el.setAttribute("data-tikz-source", source);
  const surface = prepareDiagramShell(el, "tikz", source);
  surface.innerHTML =
    '<div class="zen-tikz-loading text-[11px] opacity-60">Rendering TikZ…</div>';
  if (typeof window.zen?.renderTikz !== "function") {
    surface.innerHTML = `<pre class="zen-diagram-error">TikZ renderer not loaded. Quit (⌘Q) and relaunch the app — the preload script is only attached when a window is first created, so a plain reload isn't enough.</pre>`;
    return;
  }
  try {
    const result = await window.zen.renderTikz(source);
    if (result.ok && result.svg) {
      surface.innerHTML = result.svg;
      // Make the SVG theme-aware: common xcolor defaults like black / gray /
      // blue get remapped to the active ZenNotes palette, and unfilled text
      // falls back to the current foreground color.
      tintTikzSvg(surface);
    } else {
      surface.innerHTML = `<pre class="zen-diagram-error">TikZ error: ${escapeHtml(result.error ?? "Unknown error")}</pre>`;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    surface.innerHTML = `<pre class="zen-diagram-error">TikZ error: ${escapeHtml(message)}</pre>`;
  }
}

// ---------------------------------------------------------------------------
// JSXGraph — interactive 2D geometry / function plots
// ---------------------------------------------------------------------------

// JSXGraph exposes the `JXG` namespace as its default export. Typed as
// `unknown` because the shipped types are a namespace, not a value.
type Jxg = {
  JSXGraph: {
    initBoard: (id: string, attributes: Record<string, unknown>) => JxgBoard;
  };
};
type JxgObject = { _zenId?: string; elementClass?: number };
type JxgBoard = {
  create: (
    type: string,
    args: unknown[],
    attributes?: Record<string, unknown>,
  ) => JxgObject;
  jc: { parse: (expr: string) => unknown };
};

let jsxgraphPromise: Promise<Jxg> | null = null;
function loadJSXGraph(): Promise<Jxg> {
  if (!jsxgraphPromise) {
    jsxgraphPromise = import("jsxgraph").then((mod) => {
      const JXG =
        (mod as unknown as { default?: Jxg }).default ??
        (mod as unknown as Jxg);
      return JXG;
    });
  }
  return jsxgraphPromise;
}

interface JsxGraphConfig {
  boundingbox?: [number, number, number, number];
  axis?: boolean;
  showCopyright?: boolean;
  showNavigation?: boolean;
  width?: number;
  height?: number;
  objects?: Array<{
    id?: string;
    type: string;
    args: unknown[];
    attributes?: Record<string, unknown>;
  }>;
}

/** Read a theme token (`--z-*` RGB triplet) as a hex string so JSXGraph
 *  attributes accept it. Missing tokens fall back to a neutral grey. */
function themeColor(cssVar: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(cssVar)
    .trim();
  if (!raw) return fallback;
  const parts = raw.split(/[\s,]+/).map((n) => Number(n));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return fallback;
  const hex = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${hex(parts[0])}${hex(parts[1])}${hex(parts[2])}`;
}

async function renderJsxGraphBlock(el: HTMLElement): Promise<void> {
  const source =
    el.getAttribute("data-jsxgraph-source") ?? el.textContent?.trim() ?? "";
  if (!source) return;
  el.setAttribute("data-jsxgraph-source", source);

  let config: JsxGraphConfig;
  try {
    config = JSON.parse(source) as JsxGraphConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid JSON";
    el.innerHTML = `<pre class="zen-diagram-error">JSXGraph config must be JSON: ${escapeHtml(message)}</pre>`;
    return;
  }

  try {
    const JXG = await loadJSXGraph();
    const surface = prepareDiagramShell(el, "jsxgraph", source);
    // JSXGraph binds to a real DOM id, so we mint one per render.
    const id = `zen-jxg-${Math.random().toString(36).slice(2, 10)}`;
    const host = document.createElement("div");
    host.id = id;
    host.className = "zen-jxg-host";
    const expanded = el.dataset.zenDiagramExpanded === "true";
    const baseWidth = config.width ?? 520;
    const baseHeight = config.height ?? 320;
    const width = expanded
      ? Math.min(Math.round(baseWidth * 1.65), 1080)
      : baseWidth;
    const height = expanded
      ? Math.min(Math.round(baseHeight * 1.65), 760)
      : baseHeight;
    host.style.width = `${width}px`;
    host.style.height = `${height}px`;
    surface.appendChild(host);

    // Pull theme colors from the same CSS vars the rest of the app uses
    // so axes / grid / labels sit naturally on light or dark backgrounds.
    const axisColor = themeColor("--z-grey-1", "#7c6f64");
    const textColor = themeColor("--z-fg-1", "#3c3836");
    const gridColor = themeColor("--z-grey-dim", "#bdae93");
    const textCss = `color:${textColor};`;
    const labelDefaults = {
      strokeColor: textColor,
      fillColor: textColor,
      highlightStrokeColor: textColor,
      cssDefaultStyle: textCss,
      highlightCssDefaultStyle: textCss,
    };
    const axisAttributes = {
      strokeColor: axisColor,
      strokeOpacity: 0.85,
      highlightStrokeColor: axisColor,
      ticks: {
        strokeColor: axisColor,
        strokeOpacity: 0.6,
        label: { strokeColor: textColor, fillColor: textColor, fontSize: 11 },
      },
    };

    const board: JxgBoard = JXG.JSXGraph.initBoard(id, {
      boundingbox: config.boundingbox ?? [-5, 5, 5, -5],
      axis: config.axis ?? true,
      showCopyright: false,
      showNavigation: config.showNavigation ?? false,
      keepAspectRatio: false,
      pan: { enabled: true, needTwoFingers: false },
      zoom: { enabled: true, wheel: true },
      defaultAxes: { x: axisAttributes, y: axisAttributes },
      grid: { majorStep: [1, 1], strokeColor: gridColor, strokeOpacity: 0.25 },
      text: {
        strokeColor: textColor,
        fillColor: textColor,
        cssDefaultStyle: textCss,
        highlightCssDefaultStyle: textCss,
      },
    });

    // Track objects that declared an `id` in the config so later objects
    // can reference them via `"@id"` tokens in their `args`. JSXGraph's
    // declarative API otherwise requires real JS refs, which we can't get
    // out of JSON.
    const registry = new Map<string, JxgObject>();
    const resolveArg = (v: unknown): unknown => {
      if (typeof v === "string" && v.length > 1 && v.startsWith("@")) {
        const ref = registry.get(v.slice(1));
        if (ref) return ref;
      }
      if (Array.isArray(v)) return v.map(resolveArg);
      return v;
    };

    for (const obj of config.objects ?? []) {
      try {
        const resolvedArgs = (obj.args as unknown[]).map(resolveArg);
        // Theme-aware defaults: any object without an explicit stroke
        // picks up the foreground color so geometry stays readable on
        // light and dark backgrounds.
        const attrs: Record<string, unknown> = {
          ...(obj.attributes ?? {}),
          label: {
            ...labelDefaults,
            ...((obj.attributes?.label as
              | Record<string, unknown>
              | undefined) ?? {}),
          },
        };
        if (!("strokeColor" in attrs)) attrs.strokeColor = textColor;
        if (obj.type === "text" && !("fillColor" in attrs))
          attrs.fillColor = textColor;
        const created = board.create(obj.type, resolvedArgs, attrs);
        if (obj.id) registry.set(obj.id, created);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid object";
        const note = document.createElement("pre");
        note.className = "zen-diagram-error";
        note.textContent = `JSXGraph object "${obj.type}": ${message}`;
        surface.appendChild(note);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const surface = prepareDiagramShell(el, "jsxgraph", source);
    surface.innerHTML = `<pre class="zen-diagram-error">JSXGraph error: ${escapeHtml(message)}</pre>`;
  }
}

// ---------------------------------------------------------------------------
// function-plot — Cartesian function plotting
// ---------------------------------------------------------------------------

type FunctionPlotModule = typeof import("function-plot");
let functionPlotPromise: Promise<
  (options: Record<string, unknown>) => unknown
> | null = null;
function loadFunctionPlot(): Promise<
  (options: Record<string, unknown>) => unknown
> {
  if (!functionPlotPromise) {
    functionPlotPromise = import("function-plot").then((mod) => {
      const fn =
        (mod as unknown as { default?: unknown }).default ??
        (mod as unknown as FunctionPlotModule);
      return fn as (options: Record<string, unknown>) => unknown;
    });
  }
  return functionPlotPromise;
}

async function renderFunctionPlotBlock(el: HTMLElement): Promise<void> {
  const source =
    el.getAttribute("data-function-plot-source") ??
    el.textContent?.trim() ??
    "";
  if (!source) return;
  el.setAttribute("data-function-plot-source", source);

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(source) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid JSON";
    el.innerHTML = `<pre class="zen-diagram-error">function-plot config must be JSON: ${escapeHtml(message)}</pre>`;
    return;
  }

  try {
    const fn = await loadFunctionPlot();
    const surface = prepareDiagramShell(el, "function-plot", source);
    const host = document.createElement("div");
    host.className = "zen-function-plot-host";
    const expanded = el.dataset.zenDiagramExpanded === "true";
    const baseWidth = typeof config.width === "number" ? config.width : 560;
    const baseHeight = typeof config.height === "number" ? config.height : 320;
    const width = expanded
      ? Math.min(Math.round(baseWidth * 1.65), 1080)
      : baseWidth;
    const height = expanded
      ? Math.min(Math.round(baseHeight * 1.65), 760)
      : baseHeight;
    host.style.width = `${width}px`;
    host.style.height = `${height}px`;
    surface.appendChild(host);
    const { width: _width, height: _height, ...rest } = config;
    fn({
      target: host,
      width,
      height,
      grid: true,
      ...rest,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const surface = prepareDiagramShell(el, "function-plot", source);
    surface.innerHTML = `<pre class="zen-diagram-error">function-plot error: ${escapeHtml(message)}</pre>`;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Find every diagram placeholder inside `root` and render into it.
 * Called after each markdown render and once more on theme change.
 * Each block is skipped if its source attribute hasn't changed since the
 * last render — that way a theme switch only triggers a re-render for
 * the currently-visible blocks, and a normal re-render of unchanged
 * blocks is a no-op (we stamp `data-zen-rendered-hash`).
 */
export async function renderDiagrams(
  root: HTMLElement,
  opts: { themeKey: string; expanded?: boolean },
): Promise<void> {
  const tasks: Promise<void>[] = [];

  for (const el of Array.from(
    root.querySelectorAll<HTMLElement>(".zen-tikz"),
  )) {
    if (opts.expanded) el.dataset.zenDiagramExpanded = "true";
    else delete el.dataset.zenDiagramExpanded;
    const source = el.getAttribute("data-tikz-source") ?? el.textContent ?? "";
    const stamp = `tikz|${opts.expanded ? "expanded" : "normal"}|${source}`;
    if (el.getAttribute("data-zen-rendered-hash") === stamp) continue;
    el.setAttribute("data-zen-rendered-hash", stamp);
    tasks.push(renderTikzBlock(el));
  }

  for (const el of Array.from(
    root.querySelectorAll<HTMLElement>(".zen-jsxgraph"),
  )) {
    if (opts.expanded) el.dataset.zenDiagramExpanded = "true";
    else delete el.dataset.zenDiagramExpanded;
    const source =
      el.getAttribute("data-jsxgraph-source") ?? el.textContent ?? "";
    const stamp = `jsx|${opts.themeKey}|${opts.expanded ? "expanded" : "normal"}|${source}`;
    if (el.getAttribute("data-zen-rendered-hash") === stamp) continue;
    el.setAttribute("data-zen-rendered-hash", stamp);
    tasks.push(renderJsxGraphBlock(el));
  }

  for (const el of Array.from(
    root.querySelectorAll<HTMLElement>(".zen-function-plot"),
  )) {
    if (opts.expanded) el.dataset.zenDiagramExpanded = "true";
    else delete el.dataset.zenDiagramExpanded;
    const source =
      el.getAttribute("data-function-plot-source") ?? el.textContent ?? "";
    const stamp = `fp|${opts.themeKey}|${opts.expanded ? "expanded" : "normal"}|${source}`;
    if (el.getAttribute("data-zen-rendered-hash") === stamp) continue;
    el.setAttribute("data-zen-rendered-hash", stamp);
    tasks.push(renderFunctionPlotBlock(el));
  }

  await Promise.all(tasks);
}

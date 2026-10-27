/**
 * Typesets `$$…$$` inside Mermaid labels, as Pele's `math` render option.
 *
 * Label math is LaTeX because the syntax is Mermaid's, and Mermaid typesets it
 * with KaTeX, so a diagram uses KaTeX here even when the note's own math
 * renderer is Typst.
 *
 * The markup is KaTeX's MathML, not its HTML. Pele places it in a
 * foreignObject, and WebKit (the iPhone app, Quick Look, Safari) positions
 * KaTeX's HTML wrongly inside SVG. MathML is laid out by the browser in its own
 * math font, so a formula in a diagram can look slightly different from the
 * same formula in the note.
 *
 * Pele sizes the label box from the width and height returned here. A box sized
 * for something other than what paints inside it is the clipped-label bug the
 * HTML labels of mermaid.js kept producing (#529, #911), so the measurement is
 * of the exact element Pele receives, at the font size Pele gives it, in a
 * probe with the line height and wrapping of the box Pele wraps around it.
 *
 * Only reached through `pele-runtime`, so KaTeX stays out of any chunk the
 * diagrams' lazy loading keeps off the boot path.
 */

import katex from "katex";
import type { MathMarkup } from "pele/lazy";

/** Formulas already measured, by font size and source. Typing next to a diagram
 *  redraws it on every keystroke, and each formula would otherwise force a
 *  layout again. Only successes are kept: a formula that could not be measured
 *  (no document yet) gets another chance on the next drawing. */
const measured = new Map<string, MathMarkup>();
const MEASURED_LIMIT = 200;

let probe: HTMLDivElement | null = null;

function probeAt(size: number): HTMLDivElement | null {
  if (typeof document === "undefined" || !document.body) return null;
  if (!probe || !probe.isConnected) {
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none;display:inline-block;line-height:normal;white-space:nowrap";
    document.body.appendChild(probe);
  }
  probe.style.fontSize = `${size}px`;
  return probe;
}

function typeset(tex: string, size: number): MathMarkup | null {
  let markup: string;
  try {
    markup = katex.renderToString(tex, { displayMode: true, output: "mathml", throwOnError: true });
  } catch {
    // Pele shows the TeX as written, which is how a broken formula reads.
    return null;
  }
  const box = probeAt(size);
  if (!box) return null;
  box.innerHTML = markup;
  // KaTeX wraps the <math> in `.katex` spans whose stylesheet scales the font;
  // Pele gets the bare element, so that is what is measured.
  const math = box.querySelector("math");
  if (!math) {
    box.replaceChildren();
    return null;
  }
  box.replaceChildren(math);
  const { width, height } = math.getBoundingClientRect();
  box.replaceChildren();
  if (!(width > 0 && height > 0)) return null;
  // Rounded up: a box a fraction of a pixel short clips the last glyph.
  return { html: math.outerHTML, width: Math.ceil(width), height: Math.ceil(height) };
}

export function typesetLabelMath(tex: string, size: number): MathMarkup | null {
  const key = `${size}\u0000${tex}`;
  const known = measured.get(key);
  if (known) return known;
  const result = typeset(tex, size);
  if (result) {
    if (measured.size >= MEASURED_LIMIT) {
      const oldest = measured.keys().next().value;
      if (oldest !== undefined) measured.delete(oldest);
    }
    measured.set(key, result);
  }
  return result;
}

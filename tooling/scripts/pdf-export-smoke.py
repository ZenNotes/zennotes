#!/usr/bin/env python3
"""Exercise PDF pagination in the actual built Electron export renderer.

Requires the repository's npm dependencies, Python 3, pdfplumber and Pillow:
    python3 -m pip install pdfplumber Pillow
    python3 tooling/scripts/pdf-export-smoke.py
    python3 tooling/scripts/pdf-export-smoke.py --skip-build --output-dir output/pdf/smoke

The fixture bridge supplies an isolated note and generated images; all Markdown
rendering, export preparation and printToPDF pagination run in the application.
Only the temporary Electron profile is modified. PDFs and page contact sheets
are retained in the output directory, which defaults to a new temporary folder.
On Linux, run under a graphical session (or xvfb-run).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

try:
    import pdfplumber
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("Install test dependencies with: python3 -m pip install pdfplumber Pillow")


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).with_suffix(".md")
# Unique intrinsic dimensions identify the fixture images in the final PDF.
IMAGES = {
    "image.png": (1200, 750),
    "portrait.png": (800, 1600),
    "small.png": (80, 40),
    "sequence-first.png": (1100, 650),
    "sequence-second.png": (1000, 750),
    "forced.png": (1200, 400),
}
MARGIN = 0.7 * 72
PRINTABLE_WIDTH = 7.1 * 72
CONTINUITY = "Paragraph continuity starts here. " + " ".join(
    f"Sentence {index:03d} stays in order through every page break." for index in range(72)
) + " Paragraph continuity ends here."

# Electron's bundled fonts omit an optional FontBBox; pdfminer otherwise warns
# once per font per page while successfully extracting their text geometry.
logging.getLogger("pdfminer").setLevel(logging.ERROR)

PRELOAD = r"""
const { contextBridge, ipcRenderer } = require('electron');
const fixture = ipcRenderer.sendSync('pdf-smoke-fixture');
localStorage.setItem('zen:prefs:v2', JSON.stringify({
  pdfExportUseTheme: fixture.themed, themeId: 'github-dark', themeMode: 'dark',
  editorFontSize: 16, editorLineHeight: 1.7
}));
contextBridge.exposeInMainWorld('zen', {
  getAppInfo: () => ({ runtime: 'desktop', platform: process.platform }),
  getCurrentVault: async () => ({ root: '/pdf-smoke-fixture' }),
  listNotes: async () => [],
  listAssets: async () => Object.keys(fixture.images).map(path => ({ path })),
  readNote: async () => ({ path: 'pagination.md', title: 'Pagination', body: fixture.markdown }),
  listOverrides: async () => [],
  resolveVaultAssetUrl: (_vault, path) => fixture.images[path],
  resolveLocalAssetUrl: (_vault, _note, path) => fixture.images[path]
});
"""

HARNESS = r"""
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
app.setPath('userData', path.join(__dirname, 'user-data'));
app.on('window-all-closed', () => {});
let fixture;
ipcMain.on('pdf-smoke-fixture', event => { event.returnValue = fixture; });
// A renderer that never reaches ready must fail rather than hang a test run.
const timeout = setTimeout(() => { console.error('PDF smoke test timed out'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  for (const themed of [false, true]) {
    fixture = { themed, markdown: config.markdown, images: config.images };
    const window = new BrowserWindow({
      show: false, width: 1024, height: 1400,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: false,
        contextIsolation: true, nodeIntegration: false }
    });
    const errors = [];
    window.webContents.on('console-message', ({ level, message }) => {
      // Chromium emits this for the application's normal file:// meta CSP.
      const metaCspWarning = "The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element.";
      if (level === 'error' && message !== metaCspWarning) errors.push(message);
    });
    try {
      await window.loadFile(config.renderer, { query: { exportNote: 'pagination.md' } });
      const deadline = Date.now() + 20000;
      while (true) {
        const state = await window.webContents.executeJavaScript(`({
          state: document.body.dataset.exportState, error: document.body.dataset.exportError
        })`);
        if (state.state === 'ready') break;
        if (state.state === 'error' || Date.now() > deadline) throw Error(JSON.stringify(state));
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      const restoredLayout = await window.webContents.executeJavaScript(`(() => {
        const prose = document.querySelector('.prose-zen');
        if (!prose) return false;
        const style = getComputedStyle(prose);
        return style.columnCount === 'auto' && style.columnWidth === 'auto' &&
          [prose, ...prose.querySelectorAll('*')].every(element => {
            const current = getComputedStyle(element);
            return current.breakBefore !== 'column' && current.breakAfter !== 'column' &&
              current.breakInside !== 'avoid-column';
          });
      })()`);
      if (!restoredLayout) throw Error('Temporary pagination styles leaked into the print layout');
      if (errors.length) throw Error(errors.join('\n'));
      const theme = themed ? 'dark' : 'light';
      // Keep these options aligned with exportNoteToPdf in desktop src/main/index.ts.
      fs.writeFileSync(path.join(config.output, `${theme}.pdf`),
        await window.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true }));
    } finally {
      window.destroy();
    }
  }
  clearTimeout(timeout);
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
"""


def generate_images(directory: Path) -> dict[str, str]:
    import base64

    result = {}
    for name, (width, height) in IMAGES.items():
        picture = Image.new("RGB", (width, height), (181, 232, 207))
        draw = ImageDraw.Draw(picture)
        stroke = max(2, min(width, height) // 80)
        draw.rectangle((0, 0, width - 1, height - 1), outline=(15, 108, 68), width=stroke)
        draw.line((0, 0, width - 1, height - 1), fill=(15, 108, 68), width=stroke)
        draw.line((0, height - 1, width - 1, 0), fill=(15, 108, 68), width=stroke)
        picture.save(directory / name)
        result[name] = "data:image/png;base64," + base64.b64encode((directory / name).read_bytes()).decode()
    return result


def verify_pdf(path: Path) -> list[str]:
    errors = []

    def check(condition: bool, message: str) -> None:
        if not condition:
            errors.append(f"{path.stem}: {message}")

    with pdfplumber.open(path) as pdf:
        texts = [re.sub(r"\s+", " ", page.extract_text() or "") for page in pdf.pages]

        def page_of(text: str) -> int:
            hits = [index for index, content in enumerate(texts) if text in content]
            check(len(hits) == 1, f"expected one occurrence of {text!r}, got pages {hits}")
            return hits[0] if hits else -1

        images = {}
        for name, size in IMAGES.items():
            hits = [(index, item) for index, page in enumerate(pdf.pages)
                    for item in page.images if tuple(item["srcsize"]) == size]
            check(len(hits) == 1, f"expected one intact {name}, found {len(hits)}")
            if len(hits) != 1:
                continue
            page_index, item = images[name] = hits[0]
            expected_ratio = size[0] / size[1]
            check(abs(item["width"] / item["height"] - expected_ratio) < 0.01,
                  f"{name} aspect ratio changed")
            check(page_of(name) == page_index, f"{name} caption separated from image")
            check(item["x0"] >= MARGIN - 1 and item["x1"] <= 612 - MARGIN + 1
                  and item["top"] >= MARGIN - 1 and item["bottom"] <= 792 - MARGIN + 1,
                  f"{name} crosses printable page margins")

        landscape_intro = page_of("The following image has an explicit 1200 by 750 size hint.")
        if "image.png" in images:
            image_page, item = images["image.png"]
            check(image_page == landscape_intro,
                  f"landscape image left its introduction on page {landscape_intro + 1} "
                  f"and moved to page {image_page + 1}, leaving the reported blank gap")
            check(item["width"] >= PRINTABLE_WIDTH * 0.5 - 2,
                  "landscape image became too small to remain readable")
        if "portrait.png" in images:
            check(page_of("Portrait image") == images["portrait.png"][0],
                  "portrait heading stranded on preceding page")
        if "small.png" in images:
            check(images["small.png"][1]["width"] <= 80 * 0.75 + 1,
                  "small image enlarged beyond its intrinsic size")
        if "sequence-first.png" in images and "sequence-second.png" in images:
            first_page, first = images["sequence-first.png"]
            second_page, second = images["sequence-second.png"]
            check(first_page == page_of("Successive image introduction stays with the first picture."),
                  "first successive image left usable space on its introduction page")
            check(second_page == first_page + 1, "second successive image is on the wrong page")
            check(first["width"] < PRINTABLE_WIDTH * 0.95, "successive fixture did not exercise shrinking")
            check(second["width"] >= PRINTABLE_WIDTH - 3,
                  "second image was unnecessarily shrunk after earlier pagination changed")
        forced_page = page_of("Forced page begins here")
        check(forced_page > page_of("The forced break starts after this sentence."),
              "explicit page break was ignored")
        if "forced.png" in images:
            check(images["forced.png"][0] == forced_page,
                  "forced-break image did not stay with its section")

        # Text geometry catches clipped lines at either edge on continuation pages.
        for index, page in enumerate(pdf.pages):
            chars = [char for char in page.chars if char["text"].strip()]
            check(bool(chars), f"page {index + 1} is blank")
            check(all(char["x0"] >= MARGIN - 1 and char["x1"] <= page.width - MARGIN + 1
                      and char["top"] >= MARGIN - 1 and char["bottom"] <= page.height - MARGIN + 1
                      for char in chars), f"text is clipped beyond page {index + 1} margins")

        # A long paragraph must continue without losing words, reserving a huge bottom
        # gap, or leaving an isolated final line on the following page.
        start = page_of("Paragraph continuity starts here.")
        end = page_of("Paragraph continuity ends here.")
        check(start >= 0 and end > start, "fixture did not exercise paragraph continuation")
        check(CONTINUITY in " ".join(texts), "paragraph text was dropped, duplicated, or reordered")
        if start >= 0 and end > start:
            for index in range(start, end):
                last_bottom = max(char["bottom"] for char in pdf.pages[index].chars)
                check(last_bottom > 792 - MARGIN - 45,
                      f"paragraph continuation left a large bottom gap on page {index + 1}")
            end_lines = pdf.pages[end].extract_text_lines()
            paragraph_end = next((i for i, line in enumerate(end_lines)
                                  if "continuity ends here." in line["text"]), -1)
            check(paragraph_end >= 1, "paragraph continuation left fewer than two lines")

        # Render the real PDFs for human review and verify the page background.
        thumbnails = []
        for index, page in enumerate(pdf.pages):
            rendered = page.to_image(resolution=72).original.convert("RGB")
            background = rendered.getpixel((10, 10))
            check((max(background) < 100) if path.stem == "dark" else (min(background) > 240),
                  f"wrong background in page {index + 1} margin: {background}")
            rendered.thumbnail((306, 396))
            thumbnails.append(rendered)
        sheet = Image.new("RGB", (326 * 3, 420 * ((len(thumbnails) + 2) // 3)), (205, 205, 205))
        draw = ImageDraw.Draw(sheet)
        for index, thumbnail in enumerate(thumbnails):
            x, y = (index % 3) * 326 + 10, (index // 3) * 420 + 5
            sheet.paste(thumbnail, (x, y))
            draw.text((x, y + 399), f"Page {index + 1}", fill=(20, 20, 20))
        sheet.save(path.with_suffix(".png"))
        print(f"{path.name}: {len(pdf.pages)} pages, {sum(len(page.images) for page in pdf.pages)} images")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skip-build", action="store_true", help="reuse the existing desktop renderer build")
    parser.add_argument("--output-dir", type=Path, help="retain exported PDFs and contact sheets here")
    args = parser.parse_args()
    output = (args.output_dir or Path(tempfile.mkdtemp(prefix="zennotes-pdf-export-smoke-"))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if not args.skip_build:
        subprocess.run([shutil.which("npm") or "npm", "run", "build", "--workspace", "@zennotes/desktop"],
                       cwd=ROOT, check=True, timeout=300)
    renderer = ROOT / "apps/desktop/out/renderer/index.html"
    if not renderer.is_file():
        sys.exit("Desktop renderer is missing. Run without --skip-build.")
    electron = subprocess.check_output([shutil.which("node") or "node", "-p", "require('electron')"],
                                       cwd=ROOT / "apps/desktop", text=True, timeout=15).strip()
    with tempfile.TemporaryDirectory(prefix="zennotes-pdf-export-profile-") as temporary:
        work = Path(temporary)
        (work / "preload.cjs").write_text(PRELOAD)
        (work / "export.cjs").write_text(HARNESS)
        (work / "config.json").write_text(json.dumps({
            "markdown": FIXTURE.read_text().replace("<!-- CONTINUITY_SAMPLE -->", CONTINUITY),
            "images": generate_images(work),
            "renderer": str(renderer), "output": str(output),
        }))
        environment = dict(os.environ)
        environment.pop("ELECTRON_RUN_AS_NODE", None)
        subprocess.run([electron, str(work / "export.cjs")], cwd=ROOT, env=environment,
                       check=True, timeout=90)
    errors = [error for theme in ("light", "dark") for error in verify_pdf(output / f"{theme}.pdf")]
    print(f"PDFs and contact sheets: {output}")
    if errors:
        print("\n".join(f"FAIL: {error}" for error in errors), file=sys.stderr)
        return 1
    print("PASS: image placement, successive pagination, forced breaks, captions, geometry, and paragraph flow")
    return 0


if __name__ == "__main__":
    sys.exit(main())

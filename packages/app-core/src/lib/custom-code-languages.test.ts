// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { markdown as markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CustomCodeLanguage } from "@shared/custom-code-languages";
import { customCodeFenceHighlightExtension } from "./cm-custom-code-languages";
import { resolveCodeLanguage } from "./cm-code-languages";
import {
  customCodeLanguageRegistry,
  tokenizeCustomGrammarPreview,
} from "./custom-code-languages";
import { renderMarkdown } from "./markdown";

const gleam: CustomCodeLanguage = {
  schemaVersion: 1,
  id: "gleam",
  name: "Gleam",
  aliases: ["gleam", "gl"],
  scopeName: "source.gleam",
  enabled: true,
  grammar: JSON.stringify({
    name: "Gleam",
    scopeName: "source.gleam",
    patterns: [
      { match: "\\b(?:fn|let)\\b", name: "keyword.control.gleam" },
      { begin: '"', end: '"', name: "string.quoted.double.gleam" },
      { match: "//.*$", name: "comment.line.double-slash.gleam" },
      { match: "\\b\\d+\\b", name: "constant.numeric.gleam" },
    ],
  }),
};

// `jsonnet` is importable (nothing bundled claims it) but CodeMirror's fuzzy
// `matchLanguageName` used to hand it to JSON on a substring match, which left
// it installed and never decorated.
const jsonnet: CustomCodeLanguage = {
  ...gleam,
  id: "jsonnet",
  name: "Jsonnet",
  aliases: ["jsonnet"],
  scopeName: "source.jsonnet",
  grammar: gleam.grammar.replaceAll("gleam", "jsonnet"),
};

afterEach(async () => {
  await customCodeLanguageRegistry.replace([]);
});

describe("custom code language runtime", () => {
  it("tokenizes a TextMate grammar for the import preview", async () => {
    const source = 'fn answer = "forty two" // note\nlet n = 42';
    const tokens = await tokenizeCustomGrammarPreview(gleam, source);
    const highlighted = tokens.map((token) => ({
      text: source.slice(token.from, token.to),
      kind: token.kind,
    }));

    expect(highlighted).toContainEqual({ text: "fn", kind: "keyword" });
    expect(highlighted).toContainEqual({ text: '"forty two"', kind: "string" });
    expect(highlighted).toContainEqual({ text: "// note", kind: "comment" });
    expect(highlighted).toContainEqual({ text: "42", kind: "number" });
  });

  it("retries a cold grammar when scanner compilation uses the first line budget", async () => {
    await customCodeLanguageRegistry.replace([gleam]);
    const engine = await import("./custom-code-language-engine");
    const loaded = customCodeLanguageRegistry.resolve("gleam");
    if (!loaded) throw new Error("gleam should be registered");

    const realTokenizeLine = loaded.grammar.tokenizeLine.bind(loaded.grammar);
    let calls = 0;
    loaded.grammar.tokenizeLine = ((line, state, limit) => {
      const result = realTokenizeLine(line, state, limit);
      calls++;
      return calls === 1 ? { ...result, stoppedEarly: true } : result;
    }) as typeof loaded.grammar.tokenizeLine;

    const source = "fn main";
    const tokens = engine.tokenizeWithGrammar(loaded, source);
    expect(tokens.map((token) => source.slice(token.from, token.to))).toContain(
      "fn",
    );
    expect(calls).toBe(2);
  });

  it("uses one registry for rendered Markdown and CodeMirror decorations", async () => {
    await customCodeLanguageRegistry.replace([gleam]);
    const source = "```gleam\nfn main {\n  let answer = 42\n}\n```";

    const html = renderMarkdown(source);
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("hljs-number");

    const host = document.createElement("div");
    document.body.append(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: source,
        extensions: [
          markdownLanguage({ codeLanguages: resolveCodeLanguage }),
          customCodeFenceHighlightExtension,
        ],
      }),
    });
    expect(host.querySelector(".tok-keyword")?.textContent).toBe("fn");
    expect(host.querySelector(".tok-number")?.textContent).toBe("42");
    view.destroy();
    host.remove();
  });

  // The editor extension and the rehype plugin are installed unconditionally,
  // so the no-languages case has to cost nothing rather than walk the tree.
  it("stays inert when no grammar is installed", async () => {
    await customCodeLanguageRegistry.replace([]);
    expect(customCodeLanguageRegistry.isEmpty).toBe(true);

    const source = "```gleam\nfn main {\n  let answer = 42\n}\n```";
    expect(renderMarkdown(source)).not.toContain("hljs-keyword");

    const host = document.createElement("div");
    document.body.append(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: source,
        extensions: [
          markdownLanguage({ codeLanguages: resolveCodeLanguage }),
          customCodeFenceHighlightExtension,
        ],
      }),
    });
    expect(host.querySelector(".tok-keyword")).toBeNull();
    view.destroy();
    host.remove();
  });

  it("decorates a tag that only fuzzy-matched a built-in", async () => {
    await customCodeLanguageRegistry.replace([jsonnet]);
    // The fuzzy matcher claims this tag for JSON; the reserved list does not.
    expect(resolveCodeLanguage("jsonnet")).not.toBeNull();

    const host = document.createElement("div");
    document.body.append(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "```jsonnet\nlet answer = 42\n```",
        extensions: [
          markdownLanguage({ codeLanguages: resolveCodeLanguage }),
          customCodeFenceHighlightExtension,
        ],
      }),
    });
    expect(host.querySelector(".tok-keyword")?.textContent).toBe("let");
    view.destroy();
    host.remove();
  });

  it("drops a language that blows its tokenize budget instead of paying it twice", async () => {
    await customCodeLanguageRegistry.replace([gleam]);
    const engine = await import("./custom-code-language-engine");
    const loaded = customCodeLanguageRegistry.resolve("gleam");
    if (!loaded) throw new Error("gleam should be registered");

    // Constructing a genuinely catastrophic grammar is timing-dependent, so
    // the stall is injected: what matters is that one slow fence is enough.
    const realTokenizeLine = loaded.grammar.tokenizeLine.bind(loaded.grammar);
    let calls = 0;
    loaded.grammar.tokenizeLine = ((line, state, limit) => {
      calls++;
      const until = performance.now() + 120;
      while (performance.now() < until) {
        /* burn past the per-line budget */
      }
      return realTokenizeLine(line, state, limit);
    }) as typeof loaded.grammar.tokenizeLine;

    expect(customCodeLanguageRegistry.tokenize("gleam", "let n = 1")).toEqual(
      [],
    );
    expect(calls).toBe(1);
    expect(engine.quarantinedCustomLanguages().get("gleam")).toContain(
      "too slow",
    );
    expect(customCodeLanguageRegistry.quarantineReason("gleam")).toContain(
      "too slow",
    );

    // Every alias is unhooked, so the next render never reaches the grammar.
    expect(customCodeLanguageRegistry.resolve("gleam")).toBeNull();
    expect(customCodeLanguageRegistry.resolve("gl")).toBeNull();
    expect(customCodeLanguageRegistry.tokenize("gleam", "let n = 1")).toEqual(
      [],
    );
    expect(calls).toBe(1);
  });
});

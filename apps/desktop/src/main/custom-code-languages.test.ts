import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  customCodeLanguageRevealTarget,
  deleteCustomCodeLanguage,
  ensureCustomCodeLanguagesDir,
  getCustomCodeLanguagesDir,
  installCustomCodeLanguage,
  isGrammarFastEnough,
  listCustomCodeLanguages,
  SLOW_GRAMMAR_ERROR,
  updateCustomCodeLanguage,
  startWatchingCustomCodeLanguages,
  stopWatchingCustomCodeLanguages,
} from "./custom-code-languages";

const GLEAM_GRAMMAR = JSON.stringify({
  name: "Gleam",
  scopeName: "source.gleam",
  patterns: [{ match: "\\b(?:fn|let)\\b", name: "keyword.control.gleam" }],
});

// Passes every structural check and still hangs Oniguruma: nested quantifiers
// whose match ultimately fails backtrack exponentially, and the vetting corpus
// feeds exactly the shape that triggers it (a long run plus a failing tail).
const RUNAWAY_GRAMMAR = JSON.stringify({
  name: "Runaway",
  scopeName: "source.runaway",
  patterns: [
    { match: "(a+)+Nz$", name: "keyword.control.runaway" },
    { match: "([a-z]+)+#$", name: "comment.line.runaway" },
    { match: "(\\s+)+!$", name: "string.quoted.runaway" },
  ],
});

let tempConfig: string;
const originalConfigDir = process.env.ZENNOTES_CONFIG_DIR;

beforeEach(async () => {
  tempConfig = await mkdtemp(join(tmpdir(), "zen-languages-"));
  process.env.ZENNOTES_CONFIG_DIR = tempConfig;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.ZENNOTES_CONFIG_DIR;
  else process.env.ZENNOTES_CONFIG_DIR = originalConfigDir;
  await rm(tempConfig, { recursive: true, force: true });
});

describe("custom code languages (main)", () => {
  it("installs, lists, updates, reveals, and removes a language pack", async () => {
    const dir = await ensureCustomCodeLanguagesDir();
    expect(existsSync(join(dir, "README.md"))).toBe(true);

    await installCustomCodeLanguage({
      fileName: "gleam.tmLanguage.json",
      grammar: GLEAM_GRAMMAR,
      id: "gleam",
      name: "Gleam",
      aliases: ["gleam", "gleam-lang"],
    });

    const folder = join(getCustomCodeLanguagesDir(), "gleam");
    expect(
      JSON.parse(await readFile(join(folder, "manifest.json"), "utf8")),
    ).toMatchObject({
      id: "gleam",
      enabled: true,
      aliases: ["gleam", "gleam-lang"],
    });
    expect((await listCustomCodeLanguages())[0]).toMatchObject({
      id: "gleam",
      scopeName: "source.gleam",
      grammar: GLEAM_GRAMMAR,
    });
    expect(await customCodeLanguageRevealTarget("gleam")).toBe(
      join(folder, "grammar.tmLanguage.json"),
    );

    await updateCustomCodeLanguage({
      id: "gleam",
      enabled: false,
      aliases: ["gleam", "gl"],
    });
    expect((await listCustomCodeLanguages())[0]).toMatchObject({
      enabled: false,
      aliases: ["gleam", "gl"],
    });

    await deleteCustomCodeLanguage("../gleam");
    expect(existsSync(folder)).toBe(true);
    await deleteCustomCodeLanguage("gleam");
    expect(existsSync(folder)).toBe(false);
  });

  it("prevents built-in aliases and collisions between custom languages", async () => {
    await expect(
      installCustomCodeLanguage({
        fileName: "fake.tmLanguage.json",
        grammar: GLEAM_GRAMMAR,
        id: "javascript",
        name: "Fake JavaScript",
        aliases: [],
      }),
    ).rejects.toThrow("reserved");

    await installCustomCodeLanguage({
      fileName: "gleam.tmLanguage.json",
      grammar: GLEAM_GRAMMAR,
      id: "gleam",
      name: "Gleam",
      aliases: ["gl"],
    });
    await expect(
      installCustomCodeLanguage({
        fileName: "other.tmLanguage.json",
        grammar: GLEAM_GRAMMAR.replaceAll("gleam", "other"),
        id: "other",
        name: "Other",
        aliases: ["gl"],
      }),
    ).rejects.toThrow("already used");
  });

  it("normalizes an id from IPC before deciding whether it replaces a pack", async () => {
    await installCustomCodeLanguage({
      fileName: "gleam.tmLanguage.json",
      grammar: GLEAM_GRAMMAR,
      id: "gleam",
      name: "Gleam",
      aliases: [],
    });

    await expect(
      installCustomCodeLanguage({
        fileName: "gleam.tmLanguage.json",
        grammar: GLEAM_GRAMMAR,
        id: "Gleam",
        name: "Gleam Again",
        aliases: [],
      }),
    ).rejects.toThrow("already exists");

    const replaced = await installCustomCodeLanguage({
      fileName: "gleam.tmLanguage.json",
      grammar: GLEAM_GRAMMAR,
      id: "Gleam",
      name: "Gleam Again",
      aliases: [],
      replace: true,
    });
    expect(replaced.id).toBe("gleam");
    const languages = await listCustomCodeLanguages();
    expect(languages).toHaveLength(1);
    expect(languages[0]).toMatchObject({ id: "gleam", name: "Gleam Again" });
  });

  it("surfaces hand-edited broken packs without loading their grammar", async () => {
    const dir = await ensureCustomCodeLanguagesDir();
    const installed = await installCustomCodeLanguage({
      fileName: "gleam.tmLanguage.json",
      grammar: GLEAM_GRAMMAR,
      id: "gleam",
      name: "Gleam",
      aliases: [],
    });
    expect(installed.error).toBeUndefined();
    await writeFile(join(dir, "gleam", "grammar.tmLanguage.json"), "{broken");

    expect((await listCustomCodeLanguages())[0]).toMatchObject({
      id: "gleam",
      enabled: false,
      grammar: "",
      error: "This file is not valid JSON.",
    });
  });
});

// These share the process-wide verdict cache on purpose: the second assertion
// in each pair is that the cache is what makes the later checks instant.
describe("custom code languages watcher", () => {
  // An unreadable language folder used to end live updates for every pack:
  // chokidar's EACCES had no 'error' listener, and the watcher went quiet.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps reporting pack edits when one language folder cannot be read",
    async () => {
      const dir = await ensureCustomCodeLanguagesDir();
      const locked = join(dir, "locked");
      await mkdir(locked);
      await chmod(locked, 0o000);
      let reports = 0;
      try {
        startWatchingCustomCodeLanguages(() => reports++);
        await mkdir(join(dir, "late"));
        await expect
          .poll(
            async () => {
              await writeFile(join(dir, "late", "manifest.json"), `{"n":${Date.now()}}\n`);
              return reports;
            },
            { interval: 300, timeout: 10_000 },
          )
          .toBeGreaterThan(0);
      } finally {
        await stopWatchingCustomCodeLanguages();
        // rm cannot clear a folder it cannot read.
        await chmod(locked, 0o755);
      }
    },
    15_000,
  );
});

describe("grammar vetting", () => {
  it("kills a grammar that cannot finish the corpus, then remembers the verdict", async () => {
    expect(await isGrammarFastEnough(GLEAM_GRAMMAR, "source.gleam", 4000)).toBe(
      true,
    );

    const timeout = 1500;
    const firstRun = Date.now();
    expect(
      await isGrammarFastEnough(RUNAWAY_GRAMMAR, "source.runaway", timeout),
    ).toBe(false);
    expect(Date.now() - firstRun).toBeGreaterThanOrEqual(timeout - 50);

    const secondRun = Date.now();
    expect(
      await isGrammarFastEnough(RUNAWAY_GRAMMAR, "source.runaway", timeout),
    ).toBe(false);
    expect(Date.now() - secondRun).toBeLessThan(timeout / 2);
  }, 20_000);

  it("refuses to install a runaway grammar", async () => {
    await expect(
      installCustomCodeLanguage({
        fileName: "runaway.tmLanguage.json",
        grammar: RUNAWAY_GRAMMAR,
        id: "runaway",
        name: "Runaway",
        aliases: [],
      }),
    ).rejects.toThrow(SLOW_GRAMMAR_ERROR);
    expect(existsSync(join(getCustomCodeLanguagesDir(), "runaway"))).toBe(
      false,
    );
  }, 20_000);

  it("disables a hand-copied runaway grammar instead of shipping it to the renderer", async () => {
    const folder = join(await ensureCustomCodeLanguagesDir(), "runaway");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "grammar.tmLanguage.json"), RUNAWAY_GRAMMAR);
    await writeFile(
      join(folder, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "runaway",
        name: "Runaway",
        aliases: ["runaway"],
        scopeName: "source.runaway",
        enabled: true,
      }),
    );

    expect((await listCustomCodeLanguages())[0]).toMatchObject({
      id: "runaway",
      enabled: false,
      grammar: "",
      error: SLOW_GRAMMAR_ERROR,
    });
  }, 20_000);
});

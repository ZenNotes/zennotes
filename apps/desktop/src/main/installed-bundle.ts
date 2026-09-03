/**
 * The archive a packaged ZenNotes booted from, and whether it is still the
 * one on disk.
 *
 * Electron serves the renderer's `file://` loads out of `app.asar` through a
 * header it parses once per process and keeps for the life of that process
 * (shell/common/asar/asar_util.cc, GetOrCreateAsarArchive). Each load then
 * opens the archive by path and reads at the cached offset
 * (shell/browser/net/asar/asar_url_loader.cc). A package manager that
 * upgrades ZenNotes while it is running (pacman, dpkg, rpm, a Homebrew cask)
 * puts a new archive at the same path, and from then on every load in the old
 * process reads the new file at the old offsets. Not a crash: the wrong bytes,
 * served as the right file. The 2.41.0 "white screen" on Arch was the tail of
 * one Excalidraw locale chunk and the head of the next rendered as HTML, which
 * is exactly what the 2.40.0 header's `index.html` entry points at inside the
 * 2.41.0 archive.
 *
 * Nothing in the process can be repaired once the header is stale, so this
 * module does not try. It records what the archive looked like at boot and
 * answers one question, whether that is still the archive Electron is reading,
 * so that a load through a stale header is refused and the user is asked to
 * restart instead. Installs that never rewrite the running path (an AppImage,
 * whose mount pins the old file; a Nix store path; a Windows install locked
 * while it runs) never see a change and are never asked.
 *
 * Every read here treats the archive as the plain file it is. Electron's Node
 * fs hooks present an `.asar` path as a directory and would answer from the
 * same stale header this module exists to detect, so they are stepped around
 * with `process.noAsar` for the duration of each read.
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface ArchiveIdentity {
  ino: number;
  size: number;
  mtimeMs: number;
}

export type InstalledBundleStatus = "current" | "replaced" | "unknown";

export interface InstalledBundleGuard {
  /**
   * Whether the archive on disk is still the one this process booted from.
   * `replaced` is sticky: a stale header does not recover. `unknown` covers an
   * unpackaged run and the moments an upgrade leaves the archive unreadable,
   * and never blocks anything.
   */
  status(): InstalledBundleStatus;
  /** Version stamped into the archive that replaced ours, when readable. */
  installedVersion(): string | null;
}

/** The raw reads the guard needs, split out so tests can script a sequence. */
export interface ArchiveReader {
  identity(archivePath: string): ArchiveIdentity;
  headerDigest(archivePath: string): string;
  packageVersion(archivePath: string): string | null;
}

export function sameArchiveIdentity(
  a: ArchiveIdentity,
  b: ArchiveIdentity,
): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Runs `fn` with Electron's asar fs hooks off, so an `.asar` path is read as
 *  the file it is rather than as the archive's root directory. */
export function withRawFs<T>(fn: () => T): T {
  const proc = process as unknown as { noAsar?: boolean };
  const previous = proc.noAsar;
  proc.noAsar = true;
  try {
    return fn();
  } finally {
    proc.noAsar = previous ?? false;
  }
}

interface ArchiveHeader {
  json: Buffer;
  /** Byte position every `offset` in the header JSON is relative to. */
  dataStart: number;
}

interface AsarFileEntry {
  size?: unknown;
  offset?: unknown;
  unpacked?: unknown;
}

/**
 * The archive starts with two Pickle records, the same shape @electron/asar
 * writes and Electron's C++ reader parses: uint32 4, uint32 header pickle
 * size, uint32 payload size, uint32 JSON length, the JSON, padding to a
 * multiple of four. File data follows the header pickle.
 */
function readArchiveHeader(fd: number): ArchiveHeader {
  const lead = Buffer.alloc(16);
  if (readSync(fd, lead, 0, 16, 0) !== 16 || lead.readUInt32LE(0) !== 4) {
    throw new Error("not an asar archive");
  }
  const headerPickleSize = lead.readUInt32LE(4);
  const jsonLength = lead.readUInt32LE(12);
  if (jsonLength === 0 || jsonLength + 8 > headerPickleSize) {
    throw new Error("asar header sizes disagree");
  }
  const json = Buffer.alloc(jsonLength);
  if (readSync(fd, json, 0, jsonLength, 16) !== jsonLength) {
    throw new Error("truncated asar header");
  }
  return { json, dataStart: 8 + headerPickleSize };
}

function openArchive<T>(archivePath: string, fn: (fd: number) => T): T {
  return withRawFs(() => {
    const fd = openSync(archivePath, "r");
    try {
      return fn(fd);
    } finally {
      closeSync(fd);
    }
  });
}

export const archiveReader: ArchiveReader = {
  identity(archivePath) {
    const stats = withRawFs(() => statSync(archivePath));
    return { ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs };
  },
  headerDigest(archivePath) {
    return openArchive(archivePath, (fd) =>
      createHash("sha256").update(readArchiveHeader(fd).json).digest("hex"),
    );
  },
  packageVersion(archivePath) {
    try {
      return openArchive(archivePath, (fd) => {
        const { json, dataStart } = readArchiveHeader(fd);
        const header = JSON.parse(json.toString("utf8")) as {
          files?: Record<string, AsarFileEntry>;
        };
        const entry = header.files?.["package.json"];
        if (
          !entry ||
          entry.unpacked ||
          typeof entry.size !== "number" ||
          (typeof entry.offset !== "string" && typeof entry.offset !== "number")
        ) {
          return null;
        }
        const data = Buffer.alloc(entry.size);
        const at = dataStart + Number(entry.offset);
        if (readSync(fd, data, 0, entry.size, at) !== entry.size) return null;
        const { version } = JSON.parse(data.toString("utf8")) as {
          version?: unknown;
        };
        return typeof version === "string" ? version : null;
      });
    } catch {
      return null;
    }
  },
};

const INERT_GUARD: InstalledBundleGuard = {
  status: () => "unknown",
  installedVersion: () => null,
};

/**
 * Captures the archive at construction, so build it as early in the process
 * as possible: the header it defends is the one Electron cached at startup.
 * A null path (an unpackaged run, or asar disabled) yields a guard that never
 * reports anything.
 */
export function createInstalledBundleGuard(
  archivePath: string | null,
  reader: ArchiveReader = archiveReader,
): InstalledBundleGuard {
  if (!archivePath) return INERT_GUARD;
  let bootIdentity: ArchiveIdentity;
  let bootDigest: string;
  try {
    bootIdentity = reader.identity(archivePath);
    bootDigest = reader.headerDigest(archivePath);
  } catch {
    return INERT_GUARD;
  }
  let replaced = false;
  let installedVersion: string | null = null;
  return {
    status() {
      if (replaced) return "replaced";
      let now: ArchiveIdentity;
      try {
        now = reader.identity(archivePath);
      } catch {
        return "unknown";
      }
      if (sameArchiveIdentity(now, bootIdentity)) return "current";
      // The file moved under us. A byte-identical reinstall keeps every offset
      // valid, so compare the layout itself before calling the header stale.
      let digest: string;
      try {
        digest = reader.headerDigest(archivePath);
      } catch {
        return "unknown";
      }
      if (digest === bootDigest) {
        bootIdentity = now;
        return "current";
      }
      replaced = true;
      installedVersion = reader.packageVersion(archivePath);
      return "replaced";
    },
    installedVersion: () => installedVersion,
  };
}

export interface ReplacedBundleCopy {
  title: string;
  message: string;
  detail: string;
  buttons: [restart: string, later: string];
}

export function replacedBundleDialog(
  runningVersion: string,
  installedVersion: string | null,
): ReplacedBundleCopy {
  const updated =
    installedVersion !== null && installedVersion !== runningVersion;
  return {
    title: "ZenNotes Was Updated",
    message: updated
      ? `ZenNotes ${installedVersion} is installed, but this window is still running ${runningVersion}.`
      : `The ZenNotes install on disk was replaced while ${runningVersion} was running.`,
    detail:
      "A running copy cannot load files from the version that replaced it, so new windows and reloads would open blank. Restart ZenNotes to finish the update. Notes are saved to disk as you type.",
    buttons: ["Restart ZenNotes", "Not Now"],
  };
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );

/** What a window shows in place of a renderer it must not load. */
export function staleBundlePageHtml(
  runningVersion: string,
  installedVersion: string | null,
): string {
  const copy = replacedBundleDialog(runningVersion, installedVersion);
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(copy.title)}</title>`,
    "<style>",
    ":root { color-scheme: light dark; }",
    "body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }",
    "main { max-width: 34rem; padding: 2rem; }",
    "h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }",
    "p { margin: 0 0 0.75rem; opacity: 0.85; }",
    "</style></head><body><main>",
    `<h1>${escapeHtml(copy.title)}</h1>`,
    `<p>${escapeHtml(copy.message)}</p>`,
    `<p>${escapeHtml(copy.detail)}</p>`,
    "<p>Quit ZenNotes and open it again.</p>",
    "</main></body></html>",
  ].join("");
}

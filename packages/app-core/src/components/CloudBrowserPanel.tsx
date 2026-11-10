/**
 * Settings > Cloud > This browser: what ZenNotes in the browser keeps here
 * and whether the browser may clear it (docs/ideas/cloud-in-browser.md,
 * "Losing nothing"). Shown only by a host with the browser storage methods
 * (the browser), signed in or not: the copy lives here either way.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  BrowserAttachmentsResult,
  BrowserRelease,
  BrowserStorageStatus,
  ZenBridge,
} from "@zennotes/bridge-contract/bridge";
import { browserReleaseText } from "../lib/browser-cloud";
import { Button } from "./ui/Button";

export function hostHasBrowserStorage(bridge: ZenBridge): boolean {
  return typeof bridge.getBrowserStorageStatus === "function";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function browserSpaceLine(status: BrowserStorageStatus): string {
  if (status.usageBytes === null) return "This browser does not say how much space ZenNotes uses.";
  return status.quotaBytes
    ? `ZenNotes uses ${formatBytes(status.usageBytes)} of the ${formatBytes(status.quotaBytes)} this browser allows.`
    : `ZenNotes uses ${formatBytes(status.usageBytes)} here.`;
}

export function browserPersistenceLine(status: BrowserStorageStatus): string {
  if (status.sharedComputer) return "Signing out removes your notes from this browser.";
  return status.persisted
    ? "This browser has promised to keep ZenNotes' data."
    : "This browser may clear this data when space runs low or after a while away. What has synced stays in ZenNotes Cloud.";
}

type Busy = "persist" | "keep" | "download" | "free" | null;

export function CloudBrowserPanel({ bridge }: { bridge: ZenBridge }): JSX.Element | null {
  const [status, setStatus] = useState<BrowserStorageStatus | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<string | null>(null);
  const [release, setRelease] = useState<BrowserRelease | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void bridge.getBrowserRelease?.().then(setRelease, () => setRelease(null));
  }, [bridge]);

  const refresh = useCallback(async () => {
    try {
      setStatus(await bridge.getBrowserStorageStatus!());
    } catch {
      setStatus(null);
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!hostHasBrowserStorage(bridge) || !status) return null;

  const run = (which: Exclude<Busy, null>, action: () => Promise<BrowserStorageStatus | BrowserAttachmentsResult>, done?: (result: BrowserAttachmentsResult) => string): void => {
    if (busy) return;
    setBusy(which);
    setNote(null);
    void action()
      .then((result) => {
        if ("status" in result) {
          setStatus(result.status);
          if (done) setNote(done(result));
        } else {
          setStatus(result);
        }
      })
      .catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(null));
  };

  return (
    <section
      data-settings-search-id="cloud-browser"
      aria-labelledby="cloud-browser-heading"
      className="overflow-hidden rounded-3xl border border-paper-300/60 bg-paper-50/45"
    >
      <div className="border-b border-paper-300/45 px-5 py-5">
        <h3 id="cloud-browser-heading" className="text-sm font-semibold text-ink-900">
          This browser
        </h3>
        <p data-cloud-browser-persistence="" className="mt-1 text-xs leading-5 text-ink-500">
          {browserPersistenceLine(status)}
        </p>
        <p data-cloud-browser-space="" className="mt-1 text-xs leading-5 text-ink-500">
          {browserSpaceLine(status)}
        </p>
        {!status.sharedComputer && !status.persisted && status.canRequestPersistence && (
          <div className="mt-3">
            <Button
              variant="secondary"
              disabled={busy !== null}
              onClick={() => run("persist", () => bridge.requestBrowserStoragePersistence!())}
            >
              {busy === "persist" ? "Asking…" : "Ask this browser to keep it"}
            </Button>
          </div>
        )}
      </div>
      {!status.sharedComputer && (
      <div className="border-b border-paper-300/45 px-5 py-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-ink-900">Keep attachments in this browser</div>
            <p className="mt-1 text-xs leading-5 text-ink-500">
              When off, large attachments download as you open them.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={status.keepAttachments}
            aria-label="Keep attachments in this browser"
            data-cloud-browser-keep=""
            disabled={busy !== null}
            onClick={() => run("keep", () => bridge.setBrowserKeepAttachments!(!status.keepAttachments))}
            className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-50 ${
              status.keepAttachments ? "border-accent bg-accent" : "border-paper-400 bg-paper-200"
            }`}
          >
            <span
              className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-paper-50 shadow-sm transition-transform ${
                status.keepAttachments ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
      </div>
      )}
      <div className={release ? "border-b border-paper-300/45 px-5 py-5" : "px-5 py-5"}>
        <p data-cloud-browser-attachments="" className="text-xs leading-5 text-ink-500">
          {status.cloudOnlyAttachments === 0
            ? "Every attachment of this vault is in this browser."
            : `${status.cloudOnlyAttachments} ${status.cloudOnlyAttachments === 1 ? "attachment is" : "attachments are"} only in ZenNotes Cloud for now.`}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {!status.sharedComputer && status.cloudOnlyAttachments > 0 && bridge.downloadBrowserAttachments && (
            <Button
              variant="secondary"
              disabled={busy !== null}
              onClick={() =>
                run("download", () => bridge.downloadBrowserAttachments!(), (result) =>
                  result.failed > 0
                    ? `Downloaded ${result.changed}; ${result.failed} could not download.`
                    : `Downloaded ${result.changed}.`,
                )
              }
            >
              {busy === "download" ? "Downloading…" : "Download them"}
            </Button>
          )}
          {!status.keepAttachments && bridge.freeBrowserSpace && (
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() =>
                run("free", () => bridge.freeBrowserSpace!(), (result) =>
                  result.changed === 0
                    ? "Nothing to free: no synced attachment is large enough."
                    : `Freed ${formatBytes(result.freedBytes ?? 0)}. They download again when opened.`,
                )
              }
            >
              {busy === "free" ? "Freeing…" : "Free up space"}
            </Button>
          )}
        </div>
        {note && (
          <p role="status" className="mt-3 text-xs leading-5 text-ink-600">
            {note}
          </p>
        )}
      </div>
      {release && (
        <div data-cloud-browser-release="" className="px-5 py-5">
          <div className="text-sm font-medium text-ink-900">Running release</div>
          <p data-cloud-browser-release-name="" className="mt-1 break-all font-mono text-xs leading-5 text-ink-500">
            {release.release}
          </p>
          <div className="mt-3 text-sm font-medium text-ink-900">Manifest SHA-256</div>
          <p data-cloud-browser-manifest="" className="mt-1 break-all font-mono text-xs leading-5 text-ink-500">
            {release.manifestSha256 ?? "This build has no manifest."}
          </p>
          <div className="mt-3">
            <Button
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(browserReleaseText(release)).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

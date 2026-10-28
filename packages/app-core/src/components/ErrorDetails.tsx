import { useEffect, useState } from "react";
import { writeClipboardText } from "../lib/clipboard-text";
import { Button } from "./ui/Button";

const APP_ISSUES_URL = "https://github.com/ZenNotes/zennotes/issues";

/**
 * The technical text behind an error sentence: a closed Details disclosure
 * with the text, Copy details, and Report an Issue (the same words as the
 * Help menu and the command palette). Cloud errors and the About page's
 * update errors put it under their sentence, so the sentence stays readable
 * and support still gets every header and stack line.
 */
export function ErrorDetails({
  detail,
  ...marker
}: {
  detail: string;
} & Record<`data-${string}`, string>): JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <details {...marker} className="mt-2 text-ink-600">
      <summary className="cursor-pointer text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        Details
      </summary>
      <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-paper-300/70 bg-paper-100/70 px-3 py-2 font-mono text-xs leading-5 text-ink-600">
        {detail}
      </pre>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant="ghost"
          aria-label="Copy error details"
          onClick={() => setCopied(writeClipboardText(detail))}
        >
          {copied ? "Copied" : "Copy details"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => window.open(APP_ISSUES_URL, "_blank")}
        >
          Report an Issue
        </Button>
      </div>
    </details>
  );
}

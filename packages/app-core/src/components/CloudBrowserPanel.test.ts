import { describe, expect, it } from "vitest";
import type { BrowserStorageStatus } from "@zennotes/bridge-contract/bridge";
import { browserPersistenceLine } from "./CloudBrowserPanel";

const status: BrowserStorageStatus = {
  persisted: false,
  canRequestPersistence: true,
  usageBytes: 0,
  quotaBytes: 0,
  keepAttachments: false,
  cloudOnlyAttachments: 0,
};

describe("browserPersistenceLine", () => {
  it("says signing out removes the notes on a shared computer", () => {
    expect(browserPersistenceLine({ ...status, sharedComputer: true })).toBe(
      "Signing out removes your notes from this browser.",
    );
  });

  it("is unchanged for an ordinary sign-in", () => {
    expect(browserPersistenceLine(status)).toMatch(/may clear this data/);
    expect(browserPersistenceLine({ ...status, persisted: true })).toMatch(/promised to keep/);
  });
});

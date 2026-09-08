// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import {
  clearCloudSyncStatus,
  useCloudSyncStatusStore,
} from "../lib/cloud-auto-sync";
import { CloudTaskConflictIndicator } from "./CloudTaskConflictIndicator";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(clearCloudSyncStatus);

it("labels only tasks in a pending note and clears the label when it is resolved", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    useCloudSyncStatusStore.setState({
      lastSummary: {
        cursor: 2,
        pulled: 1,
        pushed: 0,
        conflicts: [],
        bootstrap_conflicts: [],
        local_conflicts: [],
        pending_conflicts: [
          {
            id: "note",
            item_id: "note",
            path: "Plan.md",
            cloud_path: "Moved.md",
            kind: "move",
            can_merge: false,
            has_base: true,
          },
        ],
      },
    });
    root.render(
      createElement(
        "div",
        null,
        createElement(CloudTaskConflictIndicator, { path: "Plan.md" }),
        createElement(CloudTaskConflictIndicator, { path: "Moved.md" }),
        createElement(CloudTaskConflictIndicator, { path: "Other.md" }),
      ),
    );
  });
  expect(host.textContent).toBe("Conflict pendingConflict pending");
  expect(host.querySelector("[title]")?.getAttribute("title")).toContain(
    "local note",
  );
  await act(async () => clearCloudSyncStatus());
  expect(host.textContent).toBe("");
  await act(async () => root.unmount());
});

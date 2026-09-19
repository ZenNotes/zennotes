// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeLeaf } from "./lib/pane-layout";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup() {
  const files = new Map([
    ["inbox/One.md", "# One\n\nOriginal.\n"],
    ["inbox/Other.md", "See [[One]].\n"],
  ]);
  const metadata = (path: string) => ({
    path,
    title: path.split("/").pop()!.replace(/\.md$/, ""),
    folder: path.startsWith("archive/")
      ? ("archive" as const)
      : path.startsWith("trash/")
        ? ("trash" as const)
        : ("inbox" as const),
    siblingOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    size: 0,
    tags: [],
    wikilinks: [],
    assetEmbeds: [],
    hasAttachments: false,
    excerpt: "",
  });
  const relocate = async (path: string, next: string) => {
    if (!files.has(path)) throw new Error("Missing source");
    files.set(next, files.get(path)!);
    files.delete(path);
    return metadata(next);
  };
  const bridge = {
    getCapabilities: () => ({}),
    listNotes: async () => [...files.keys()].map(metadata),
    listFolders: async () => [
      { folder: "inbox" as const, subpath: "Work", siblingOrder: 0 },
    ],
    hasAssetsDir: async () => false,
    scanTasks: async () => [],
    scanTasksForPath: async () => [],
    getRemoteWorkspaceInfo: async () => null,
    readNote: async (path: string) => ({
      ...metadata(path),
      body: files.get(path)!,
    }),
    writeNote: vi.fn(async (path: string, body: string) => {
      files.set(path, body);
      return metadata(path);
    }),
    setVaultSettings: vi.fn(async (value) => value),
    moveNote: vi.fn(async (path: string, folder: string, subpath: string) =>
      relocate(path, `${folder}/${subpath ? subpath + "/" : ""}One.md`),
    ),
    renameNote: vi.fn(async (path: string, title: string) =>
      relocate(path, `inbox/${title}.md`),
    ),
    archiveNote: vi.fn(async (path: string) =>
      relocate(path, "archive/One.md"),
    ),
    unarchiveNote: vi.fn(async (path: string) =>
      relocate(path, "inbox/One.md"),
    ),
    moveToTrash: vi.fn(async (path: string) => relocate(path, "trash/One.md")),
    restoreFromTrash: vi.fn(async (path: string) =>
      relocate(path, "inbox/One.md"),
    ),
    deleteNote: vi.fn(async (path: string) => {
      files.delete(path);
    }),
  };
  Object.defineProperty(window, "zen", { configurable: true, value: bridge });
  const { useStore } = await import("./store");
  const leaf = makeLeaf(["inbox/One.md", "inbox/Other.md"], "inbox/One.md");
  useStore.setState({
    vault: { root: "/test", name: "Test" },
    notes: [...files.keys()].map(metadata),
    folders: await bridge.listFolders(),
    paneLayout: leaf,
    activePaneId: leaf.id,
    selectedPath: "inbox/One.md",
    noteContents: Object.fromEntries(
      [...files].map(([path, body]) => [path, { ...metadata(path), body }]),
    ),
    noteDirty: {},
    syncTitleHeadingOnRename: false,
  });
  return { useStore, files, bridge, relocate, metadata };
}

describe("note relocation saves", () => {
  it("saves before moving and keeps edits made during the move at the canonical path", async () => {
    const s = await setup(),
      gate = deferred();
    s.useStore.getState().updateNoteBody("inbox/One.md", "Before move.\n");
    s.bridge.moveNote.mockImplementation(async (path) => {
      expect(s.files.get(path)).toBe("Before move.\n");
      await gate.promise;
      return s.relocate(path, "inbox/Work/One 2.md");
    });
    const moving = s.useStore
      .getState()
      .moveNote("inbox/One.md", "inbox", "Work");
    await vi.waitFor(() => expect(s.bridge.moveNote).toHaveBeenCalled());
    s.useStore
      .getState()
      .updateNoteBody("inbox/One.md", "During move: café 日本語.  \n");
    gate.resolve();
    await moving;
    expect(s.files.has("inbox/One.md")).toBe(false);
    expect(s.files.get("inbox/Work/One 2.md")).toBe(
      "During move: café 日本語.  \n",
    );
    expect(s.useStore.getState().selectedPath).toBe("inbox/Work/One 2.md");
    expect(s.useStore.getState().noteDirty["inbox/Work/One 2.md"]).toBe(false);
  });

  it("does not relocate a note if its save failed", async () => {
    const s = await setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    s.bridge.writeNote.mockRejectedValue(new Error("disk full"));
    s.useStore.getState().updateNoteBody("inbox/One.md", "Keep unsaved.\n");
    await s.useStore.getState().moveNote("inbox/One.md", "inbox", "Work");
    expect(s.bridge.moveNote).not.toHaveBeenCalled();
    expect(s.useStore.getState().noteContents["inbox/One.md"].body).toBe(
      "Keep unsaved.\n",
    );
  });

  it("waits for a pending move before completing a vault-switch save", async () => {
    const s = await setup(),
      gate = deferred();
    s.bridge.moveNote.mockImplementation(async (path) => {
      await gate.promise;
      return s.relocate(path, "inbox/Work/One.md");
    });
    const moving = s.useStore
      .getState()
      .moveNote("inbox/One.md", "inbox", "Work");
    await vi.waitFor(() => expect(s.bridge.moveNote).toHaveBeenCalled());
    let flushed = false;
    const flushing = s.useStore
      .getState()
      .flushDirtyNotes()
      .then(() => {
        flushed = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushed).toBe(false);
    gate.resolve();
    await Promise.all([moving, flushing]);
    expect(s.files.has("inbox/Work/One.md")).toBe(true);
  });
});

async function publicSetup() {
  const s = await setup();
  const actions = await import("./notes");
  const confirms = await import("./lib/confirm-requests");
  const prompts = await import("./lib/prompt-requests");
  const answer = (value: string | null) =>
    prompts.settlePromptRequest(prompts.getPromptRequest()!, value);
  return {
    ...s,
    ...actions,
    ...prompts,
    ...confirms,
    confirm: (value: boolean) =>
      confirms.settleConfirmRequest(confirms.getConfirmRequest()!, value),
    answer,
    host: { isCurrent: () => true },
  };
}
describe("public note move", () => {
  it("prompts, saves, and moves through the public action", async () => {
    const s = await publicSetup();
    s.useStore
      .getState()
      .updateNoteBody("inbox/One.md", "Saved via public action.\n");
    const moving = s.requestMoveNote(s.host, "inbox/One.md");
    expect(s.getPromptRequest()?.options.initialValue).toBe("inbox");
    s.answer("inbox/Work");
    expect(await moving).toBe("completed");
    expect(s.files.get("inbox/Work/One.md")).toBe("Saved via public action.\n");
  });
  it("cancels unchanged targets and invalid destinations without writes", async () => {
    const s = await publicSetup();
    for (const target of [
      null,
      "inbox",
      "inbox/../Other",
      "inbox/.hidden",
      "inbox/People.base",
      "inbox/People.base/pages",
      "trash",
      "inbox/bad\0name",
    ]) {
      const moving = s.requestMoveNote(s.host, "inbox/One.md");
      s.answer(target);
      expect(await moving).toBe("cancelled");
    }
    expect(s.bridge.moveNote).not.toHaveBeenCalled();
  });
  it("does not dispatch a dialog result after the host switches vaults", async () => {
    const s = await publicSetup();
    let current = true;
    const moving = s.requestMoveNote(
      { isCurrent: () => current },
      "inbox/One.md",
    );
    current = false;
    s.answer("inbox/Work");
    expect(await moving).toBe("stale");
    expect(s.bridge.moveNote).not.toHaveBeenCalled();
  });
  it("propagates host errors and permits the next attempt", async () => {
    const s = await publicSetup();
    s.bridge.moveNote.mockRejectedValueOnce(new Error("permission denied"));
    const moving = s.requestMoveNote(s.host, "inbox/One.md");
    s.answer("inbox/Work");
    await expect(moving).rejects.toThrow("permission denied");
    const retry = s.requestMoveNote(s.host, "inbox/One.md");
    s.answer("inbox/Work");
    expect(await retry).toBe("completed");
  });
  it("rejects missing notes, database records, and simultaneous prompts", async () => {
    const s = await publicSetup();
    expect(await s.requestMoveNote(s.host, "missing.md")).toBe("unavailable");
    s.useStore.setState({
      notes: [
        ...s.useStore.getState().notes,
        s.metadata("inbox/People.base/Record.md"),
      ],
    });
    expect(await s.requestMoveNote(s.host, "inbox/People.base/Record.md")).toBe(
      "unavailable",
    );
    const first = s.requestMoveNote(s.host, "inbox/One.md");
    expect(await s.requestMoveNote(s.host, "inbox/Other.md")).toBe(
      "unavailable",
    );
    s.answer(null);
    expect(await first).toBe("cancelled");
  });
});

describe("note move coordination", () => {
  it("preserves exact scope, comments, references, task metadata, and manual order", async () => {
    const s = await setup();
    const { parseTasksFromBody } = await import("@shared/tasks");
    const path = "inbox/One.md",
      neighbor = "inbox/One.md.backup";
    s.files.set(neighbor, "Keep backup.\n");
    s.useStore.setState({
      manualNoteOrder: { inbox: [path, "inbox/Other.md"] },
      noteComments: {
        [path]: [
          {
            id: "comment",
            notePath: path,
            body: "Keep comment",
            anchorStart: 0,
            anchorEnd: 0,
            anchorText: "",
            resolvedAt: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
      noteRefs: { [path]: { path, pinned: true } as never },
      vaultTasks: parseTasksFromBody("- [ ] Task\n", {
        path,
        title: "One",
        folder: "inbox",
      }),
      noteContents: {
        ...s.useStore.getState().noteContents,
        [neighbor]: { ...s.metadata(neighbor), body: "Keep backup.\n" },
      },
      noteDirty: { [neighbor]: false },
    });
    await s.useStore.getState().moveNote(path, "archive", "Work", () => true);
    const current = s.useStore.getState(),
      next = "archive/Work/One.md";
    expect(current.noteComments[next][0].notePath).toBe(next);
    expect(current.noteRefs[next].path).toBe(next);
    expect(current.vaultTasks[0]).toMatchObject({
      sourcePath: next,
      noteFolder: "archive",
      noteTitle: "One",
    });
    expect(current.manualNoteOrder.inbox).not.toContain(path);
    expect(current.manualNoteOrder["archive/Work"]).toContain(next);
    expect(s.files.get(neighbor)).toBe("Keep backup.\n");
  });

  it("reconciles a dispatched move but leaves the new vault UI untouched", async () => {
    const s = await setup(),
      gate = deferred();
    s.bridge.moveNote.mockImplementation(async (path) => {
      await gate.promise;
      return s.relocate(path, "inbox/Work/One.md");
    });
    const moving = s.useStore
      .getState()
      .moveNote("inbox/One.md", "inbox", "Work", () => true);
    await vi.waitFor(() => expect(s.bridge.moveNote).toHaveBeenCalled());
    const nextVault = { root: "/other", name: "Other" };
    s.useStore.setState({
      vault: nextVault,
      notes: [],
      noteContents: {},
      noteDirty: {},
      selectedPath: null,
      activeNote: null,
    });
    gate.resolve();
    await moving;
    expect(s.useStore.getState().vault).toBe(nextVault);
    expect(s.useStore.getState().notes).toEqual([]);
    expect(s.useStore.getState().selectedPath).toBeNull();
  });

  it("rejects a move during a closed-note task write, then permits it when settled", async () => {
    const s = await setup(),
      gate = deferred();
    const { parseTasksFromBody } = await import("@shared/tasks");
    const path = "inbox/One.md";
    s.files.set(path, "- [ ] Task\n");
    const task = parseTasksFromBody(s.files.get(path)!, {
      path,
      title: "One",
      folder: "inbox",
    })[0];
    s.useStore.setState({
      noteContents: {},
      noteDirty: {},
      vaultTasks: [task],
    });
    s.bridge.writeNote.mockImplementationOnce(async (path, body) => {
      await gate.promise;
      s.files.set(path, body);
      return s.metadata(path);
    });
    const writing = s.useStore.getState().toggleTaskFromList(task);
    await vi.waitFor(() => expect(s.bridge.writeNote).toHaveBeenCalled());
    await expect(
      s.useStore.getState().moveNote(path, "inbox", "Work", () => true),
    ).rejects.toThrow("pending task changes");
    expect(s.bridge.moveNote).not.toHaveBeenCalled();
    gate.resolve();
    await writing;
    await s.useStore.getState().moveNote(path, "inbox", "Work", () => true);
    expect(s.files.get("inbox/Work/One.md")).toBe("- [x] Task\n");
    expect(s.files.has(path)).toBe(false);
  });

  it("blocks task writes and retains buffers when a failed move cannot be rolled back", async () => {
    const s = await setup(),
      gate = deferred();
    const { parseTasksFromBody } = await import("@shared/tasks");
    const path = "inbox/One.md";
    s.bridge.moveNote.mockImplementation(async () => {
      await gate.promise;
      throw new Error("FOLDER_STATE_UNCERTAIN: rollback failed");
    });
    const moving = s.useStore
      .getState()
      .moveNote(path, "inbox", "Work", () => true);
    const failed = expect(moving).rejects.toThrow("FOLDER_STATE_UNCERTAIN");
    await vi.waitFor(() => expect(s.bridge.moveNote).toHaveBeenCalled());
    const task = parseTasksFromBody("- [ ] Task\n", {
      path,
      title: "One",
      folder: "inbox",
    })[0];
    await s.useStore.getState().toggleTaskFromList(task);
    expect(s.bridge.writeNote).not.toHaveBeenCalled();
    s.useStore.getState().updateNoteBody(path, "Retain pending edit.\n");
    gate.resolve();
    await failed;
    await s.useStore.getState().persistNote(path);
    expect(s.bridge.writeNote).not.toHaveBeenCalled();
    expect(s.useStore.getState().noteContents[path].body).toBe(
      "Retain pending edit.\n",
    );
    await expect(s.useStore.getState().flushDirtyNotes()).rejects.toThrow(
      "FOLDER_STATE_UNCERTAIN",
    );
  });
});

it.each([false, true])(
  "uses logical prompt paths with remapped primary folders (root: %s)",
  async (root) => {
    const s = await publicSetup();
    const path = root ? "Work/One.md" : "My Notes/Work/One.md";
    s.useStore.setState({
      notes: [s.metadata(path)],
      vaultSettings: {
        ...s.useStore.getState().vaultSettings,
        primaryNotesLocation: root ? "root" : "inbox",
        systemFolderPaths: { inbox: "My Notes", archive: "Old Notes" },
      },
    });
    const moving = s.requestMoveNote(s.host, path);
    expect(s.getPromptRequest()?.options.initialValue).toBe("inbox/Work");
    s.answer("inbox/Work");
    expect(await moving).toBe("cancelled");
  },
);

it("finishes comment writes before moving their sidecar", async () => {
  const s = await setup(),
    gate = deferred();
  const writeComments = vi.fn(async () => {
    await gate.promise;
    return [];
  });
  Object.assign(s.bridge, { writeNoteComments: writeComments });
  s.useStore.setState({ noteComments: { "inbox/One.md": [] } });
  const commenting = s.useStore.getState().addNoteComment({
    notePath: "inbox/One.md",
    body: "Pending comment",
  } as never);
  await vi.waitFor(() => expect(writeComments).toHaveBeenCalled());
  const moving = s.useStore
    .getState()
    .moveNote("inbox/One.md", "inbox", "Work", () => true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(s.bridge.moveNote).not.toHaveBeenCalled();
  gate.resolve();
  await Promise.all([commenting, moving]);
  expect(s.bridge.moveNote).toHaveBeenCalledOnce();
});

it("flushes an open-buffer task edit before its debounce when moving", async () => {
  const s = await setup();
  const { parseTasksFromBody } = await import("@shared/tasks");
  const path = "inbox/One.md",
    body = "- [ ] Task\n";
  s.files.set(path, body);
  const task = parseTasksFromBody(body, {
    path,
    title: "One",
    folder: "inbox",
  })[0];
  s.useStore.setState({
    noteContents: { [path]: { ...s.metadata(path), body } },
    noteDirty: {},
    vaultTasks: [task],
  });
  await s.useStore.getState().toggleTaskFromList(task);
  expect(s.files.get(path)).toBe(body);
  await s.useStore.getState().moveNote(path, "inbox", "Work", () => true);
  expect(s.files.get("inbox/Work/One.md")).toBe("- [x] Task\n");
  expect(s.files.has(path)).toBe(false);
});

describe("public note rename", () => {
  it("rewrites clean and late-edited inbound buffers using the canonical title", async () => {
    const s = await publicSetup(),
      gate = deferred();
    const clean = "inbox/Clean.md";
    s.files.set(clean, "Clean [[One|alias]].\n");
    const pane = makeLeaf(
      ["inbox/One.md", "inbox/Other.md", clean],
      "inbox/One.md",
    );
    s.useStore.setState({
      paneLayout: pane,
      activePaneId: pane.id,
      notes: [...s.useStore.getState().notes, s.metadata(clean)],
      noteContents: {
        ...s.useStore.getState().noteContents,
        [clean]: { ...s.metadata(clean), body: s.files.get(clean)! },
      },
    });
    s.useStore.getState().updateNoteBody("inbox/Other.md", "Before [[One]].\n");
    s.bridge.renameNote.mockImplementation(async (path) => {
      expect(s.files.get("inbox/Other.md")).toBe("Before [[One]].\n");
      await gate.promise;
      return s.relocate(path, "inbox/Renamed 2.md");
    });
    const renaming = s.requestRenameNote(s.host, "inbox/One.md");
    expect(s.getPromptRequest()?.options.initialValue).toBe("One");
    s.answer("Renamed");
    await vi.waitFor(() => expect(s.bridge.renameNote).toHaveBeenCalled());
    s.useStore
      .getState()
      .updateNoteBody("inbox/One.md", "Late source: café 日本語.  \n");
    s.useStore
      .getState()
      .updateNoteBody(
        "inbox/Other.md",
        "Late [[One#Heading|alias]] and `[[One]]`.  \n",
      );
    gate.resolve();
    expect(await renaming).toBe("completed");
    expect(s.files.has("inbox/One.md")).toBe(false);
    expect(s.files.get("inbox/Renamed 2.md")).toBe(
      "Late source: café 日本語.  \n",
    );
    expect(s.files.get("inbox/Other.md")).toBe(
      "Late [[Renamed 2#Heading|alias]] and `[[One]]`.  \n",
    );
    expect(s.files.get(clean)).toBe("Clean [[Renamed 2|alias]].\n");
    expect(s.useStore.getState().noteContents[clean].body).toBe(
      s.files.get(clean),
    );
    expect(s.useStore.getState().selectedPath).toBe("inbox/Renamed 2.md");
  });

  it("cancels empty, unchanged, and invalid titles without writing", async () => {
    const s = await publicSetup();
    for (const title of [
      null,
      "",
      "One",
      "  One  ",
      "../Other",
      "dir/Other",
      "bad\\name",
      ".hidden",
      "Bad: title",
      "Bad? title",
      "bad\0name",
    ]) {
      const renaming = s.requestRenameNote(s.host, "inbox/One.md");
      s.answer(title);
      expect(await renaming).toBe("cancelled");
    }
    expect(s.bridge.renameNote).not.toHaveBeenCalled();
  });

  it("rejects stale prompts and prevents overlap with a move prompt", async () => {
    const s = await publicSetup();
    let current = true;
    const renaming = s.requestRenameNote(
      { isCurrent: () => current },
      "inbox/One.md",
    );
    expect(await s.requestMoveNote(s.host, "inbox/Other.md")).toBe(
      "unavailable",
    );
    current = false;
    s.answer("Renamed");
    expect(await renaming).toBe("stale");
    expect(s.bridge.renameNote).not.toHaveBeenCalled();
  });

  it("blocks rename on a failed inbound save and releases the action for retry", async () => {
    const s = await publicSetup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    s.useStore
      .getState()
      .updateNoteBody("inbox/Other.md", "Unsaved [[One]].\n");
    s.bridge.writeNote.mockRejectedValue(new Error("disk full"));
    const renaming = s.requestRenameNote(s.host, "inbox/One.md");
    s.answer("Renamed");
    await expect(renaming).rejects.toThrow("unsaved changes");
    expect(s.bridge.renameNote).not.toHaveBeenCalled();
    s.bridge.writeNote.mockImplementation(async (path, body) => {
      s.files.set(path, body);
      return s.metadata(path);
    });
    const retry = s.requestRenameNote(s.host, "inbox/One.md");
    s.answer("Renamed");
    expect(await retry).toBe("completed");
    expect(s.files.get("inbox/Other.md")).toBe("Unsaved [[Renamed]].\n");
  });

  it("keeps rewritten buffers dirty if persistence fails after the rename", async () => {
    const s = await publicSetup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    s.bridge.writeNote.mockRejectedValue(new Error("disk full"));
    const renaming = s.requestRenameNote(s.host, "inbox/One.md");
    s.answer("Renamed");
    await expect(renaming).rejects.toThrow("unsaved changes");
    expect(s.useStore.getState().selectedPath).toBe("inbox/Renamed.md");
    expect(s.useStore.getState().noteDirty["inbox/Other.md"]).toBe(true);
    expect(s.useStore.getState().noteContents["inbox/Other.md"].body).toBe(
      "See [[Renamed]].\n",
    );
  });

  it("finishes a dispatched rename before draining saves for a vault switch", async () => {
    const s = await publicSetup(),
      gate = deferred();
    let current = true;
    s.bridge.renameNote.mockImplementation(async (path) => {
      await gate.promise;
      return s.relocate(path, "inbox/Renamed.md");
    });
    const renaming = s.requestRenameNote(
      { isCurrent: () => current },
      "inbox/One.md",
    );
    s.answer("Renamed");
    await vi.waitFor(() => expect(s.bridge.renameNote).toHaveBeenCalled());
    s.useStore.getState().updateNoteBody("inbox/Other.md", "During [[One]].\n");
    current = false;
    let flushed = false;
    const flushing = s.useStore
      .getState()
      .flushDirtyNotes()
      .then(() => {
        flushed = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushed).toBe(false);
    gate.resolve();
    expect(await renaming).toBe("stale");
    await flushing;
    expect(s.files.get("inbox/Other.md")).toBe("During [[Renamed]].\n");
    expect(s.files.has("inbox/One.md")).toBe(false);
  });

  it("does not reconcile a dispatched rename into a replaced vault", async () => {
    const s = await publicSetup(),
      gate = deferred();
    s.bridge.renameNote.mockImplementation(async (path) => {
      await gate.promise;
      return s.relocate(path, "inbox/Renamed.md");
    });
    const renaming = s.requestRenameNote(s.host, "inbox/One.md");
    s.answer("Renamed");
    await vi.waitFor(() => expect(s.bridge.renameNote).toHaveBeenCalled());
    s.useStore.setState({
      vault: { root: "/other", name: "Other" },
      notes: [],
      noteContents: {},
      noteDirty: {},
      selectedPath: null,
      activeNote: null,
    });
    gate.resolve();
    expect(await renaming).toBe("stale");
    expect(s.useStore.getState().notes).toEqual([]);
    expect(s.useStore.getState().selectedPath).toBeNull();
    expect(s.bridge.writeNote).not.toHaveBeenCalled();
    expect(s.bridge.setVaultSettings).not.toHaveBeenCalled();
  });
});

it("holds all task and note writes during rename and retains buffers on failed rollback", async () => {
  const s = await publicSetup(),
    gate = deferred();
  const { parseTasksFromBody } = await import("@shared/tasks");
  s.bridge.renameNote.mockImplementation(async () => {
    await gate.promise;
    throw new Error("FOLDER_STATE_UNCERTAIN: rollback failed");
  });
  const renaming = s.requestRenameNote(s.host, "inbox/One.md");
  s.answer("Renamed");
  const failed = expect(renaming).rejects.toThrow("FOLDER_STATE_UNCERTAIN");
  await vi.waitFor(() => expect(s.bridge.renameNote).toHaveBeenCalled());
  const task = parseTasksFromBody("- [ ] Task\n", {
    path: "inbox/Other.md",
    title: "Other",
    folder: "inbox",
  })[0];
  await s.useStore.getState().toggleTaskFromList(task);
  s.useStore.getState().updateNoteBody("inbox/Other.md", "Keep [[One]].\n");
  await s.useStore.getState().persistNote("inbox/Other.md");
  expect(s.bridge.writeNote).not.toHaveBeenCalled();
  gate.resolve();
  await failed;
  expect(s.useStore.getState().noteContents["inbox/Other.md"].body).toBe(
    "Keep [[One]].\n",
  );
  await expect(s.useStore.getState().flushDirtyNotes()).rejects.toThrow(
    "FOLDER_STATE_UNCERTAIN",
  );
  expect(s.bridge.writeNote).not.toHaveBeenCalled();
});

it("rewrites an edit that arrives during the post-rename refresh", async () => {
  const s = await publicSetup(),
    gate = deferred();
  const refresh = s.useStore.getState().refreshNotes;
  const refreshing = vi.fn(async () => {
    await gate.promise;
    await refresh();
  });
  s.useStore.setState({ refreshNotes: refreshing });
  const renaming = s.requestRenameNote(s.host, "inbox/One.md");
  s.answer("Renamed");
  await vi.waitFor(() => expect(refreshing).toHaveBeenCalled());
  s.useStore.getState().updateNoteBody("inbox/Other.md", "Late [[One]].\n");
  gate.resolve();
  expect(await renaming).toBe("completed");
  expect(s.files.get("inbox/Other.md")).toBe("Late [[Renamed]].\n");
});

it("rejects rename during a closed-note tag rewrite and blocks a new tag rewrite during rename", async () => {
  const s = await publicSetup(),
    readGate = deferred(),
    renameGate = deferred();
  s.files.set("inbox/Other.md", "#old [[One]]\n");
  s.useStore.setState({
    notes: s.useStore
      .getState()
      .notes.map((note) =>
        note.path === "inbox/Other.md" ? { ...note, tags: ["old"] } : note,
      ),
    noteContents: {},
    noteDirty: {},
    activeNote: null,
  });
  const readNote = vi
    .spyOn(s.bridge, "readNote")
    .mockImplementationOnce(async (path) => {
      await readGate.promise;
      return { ...s.metadata(path), body: s.files.get(path)! };
    });
  const tagging = s.useStore.getState().renameTag("old", "new");
  await vi.waitFor(() => expect(readNote).toHaveBeenCalled());
  const rejected = s.requestRenameNote(s.host, "inbox/One.md");
  s.answer("Renamed");
  await expect(rejected).rejects.toThrow("pending note changes");
  expect(s.bridge.renameNote).not.toHaveBeenCalled();
  readGate.resolve();
  await tagging;
  s.bridge.renameNote.mockImplementation(async (path) => {
    await renameGate.promise;
    return s.relocate(path, "inbox/Renamed.md");
  });
  const renaming = s.requestRenameNote(s.host, "inbox/One.md");
  s.answer("Renamed");
  await vi.waitFor(() => expect(s.bridge.renameNote).toHaveBeenCalled());
  readNote.mockClear();
  await s.useStore.getState().renameTag("new", "other");
  expect(readNote).not.toHaveBeenCalled();
  renameGate.resolve();
  expect(await renaming).toBe("completed");
});

it("keeps the rename registered until final backlink saves finish", async () => {
  const s = await publicSetup(),
    gate = deferred();
  s.bridge.writeNote.mockImplementationOnce(async (path, body) => {
    await gate.promise;
    s.files.set(path, body);
    return s.metadata(path);
  });
  const renaming = s.requestRenameNote(s.host, "inbox/One.md");
  s.answer("Renamed");
  await vi.waitFor(() => expect(s.bridge.writeNote).toHaveBeenCalled());
  const read = vi.spyOn(s.bridge, "readNote");
  s.useStore.setState({
    notes: s.useStore
      .getState()
      .notes.map((note) => ({ ...note, tags: ["tag"] })),
  });
  await s.useStore.getState().renameTag("tag", "changed");
  expect(read).not.toHaveBeenCalled();
  let flushed = false;
  const flushing = s.useStore
    .getState()
    .flushDirtyNotes()
    .then(() => {
      flushed = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(flushed).toBe(false);
  gate.resolve();
  expect(await renaming).toBe("completed");
  await flushing;
  expect(s.files.get("inbox/Other.md")).toBe("See [[Renamed]].\n");
});

it("drains a closed-note writer before a vault-switch save completes", async () => {
  const s = await setup(),
    gate = deferred();
  s.files.set("inbox/Other.md", "#old [[One]]\n");
  s.useStore.setState({
    notes: s.useStore
      .getState()
      .notes.map((note) => ({ ...note, tags: ["old"] })),
    noteContents: {},
    noteDirty: {},
    activeNote: null,
  });
  const read = vi
    .spyOn(s.bridge, "readNote")
    .mockImplementationOnce(async (path) => {
      await gate.promise;
      return { ...s.metadata(path), body: s.files.get(path)! };
    });
  const tagging = s.useStore.getState().renameTag("old", "new");
  await vi.waitFor(() => expect(read).toHaveBeenCalled());
  let flushed = false;
  const flushing = s.useStore
    .getState()
    .flushDirtyNotes()
    .then(() => {
      flushed = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(flushed).toBe(false);
  gate.resolve();
  await Promise.all([tagging, flushing]);
  expect(s.files.get("inbox/Other.md")).toBe("#new [[One]]\n");
});

it("refreshes visible task text after renamed backlink buffers are saved", async () => {
  const s = await publicSetup();
  const { parseTasksFromBody, TASKS_TAB_PATH } = await import("@shared/tasks");
  s.files.set("inbox/Other.md", "- [ ] Read [[One]]\n");
  const pane = makeLeaf(
    ["inbox/One.md", "inbox/Other.md", TASKS_TAB_PATH],
    TASKS_TAB_PATH,
  );
  const scanTasks = vi.fn(async () =>
    parseTasksFromBody(
      s.files.get("inbox/Other.md")!,
      s.metadata("inbox/Other.md"),
    ),
  );
  Object.assign(s.bridge, { scanTasks });
  s.useStore.setState({
    paneLayout: pane,
    activePaneId: pane.id,
    selectedPath: TASKS_TAB_PATH,
    noteContents: {
      "inbox/Other.md": {
        ...s.metadata("inbox/Other.md"),
        body: s.files.get("inbox/Other.md")!,
      },
    },
  });
  const renaming = s.requestRenameNote(s.host, "inbox/One.md");
  s.answer("Renamed");
  expect(await renaming).toBe("completed");
  expect(scanTasks).toHaveBeenCalled();
  expect(s.useStore.getState().vaultTasks[0].rawText).toContain("[[Renamed]]");
});

it("updates open inbound links when a database record page is renamed", async () => {
  const s = await setup();
  const csvPath = "inbox/Records.base/data.csv";
  Object.assign(s.bridge, { writeDatabaseSchema: vi.fn(async () => {}) });
  s.useStore.setState({
    databases: {
      [csvPath]: {
        version: 1,
        idFieldId: "id",
        path: csvPath,
        title: "Records",
        fields: [],
        views: [],
        activeViewId: "view",
        rows: [{ id: "row", cells: { id: "row" } }],
        pages: { row: "inbox/One.md" },
      },
    },
  });
  s.bridge.renameNote.mockImplementation(async (path) =>
    s.relocate(path, "inbox/Renamed.md"),
  );
  await s.useStore.getState().renameRecordPage(csvPath, "row");
  expect(s.useStore.getState().databases[csvPath].pages?.row).toBe(
    "inbox/Renamed.md",
  );
  expect(s.files.get("inbox/Other.md")).toBe("See [[Renamed]].\n");
  await s.useStore.getState().flushDirtyNotes();
});

it("refreshes already-mounted Home tasks after rename", async () => {
  const s = await publicSetup();
  const { parseTasksFromBody } = await import("@shared/tasks");
  s.files.set("inbox/Other.md", "- [ ] Read [[One]]\n");
  const scanTasks = vi.fn(async () =>
    parseTasksFromBody(
      s.files.get("inbox/Other.md")!,
      s.metadata("inbox/Other.md"),
    ),
  );
  Object.assign(s.bridge, { scanTasks });
  const marker = document.createElement("div");
  marker.dataset.homeNav = "tasks";
  document.body.append(marker);
  try {
    s.useStore.setState({
      selectedPath: null,
      activeNote: null,
      vaultTasks: await scanTasks(),
      noteContents: {
        "inbox/Other.md": {
          ...s.metadata("inbox/Other.md"),
          body: s.files.get("inbox/Other.md")!,
        },
      },
    });
    const renaming = s.requestRenameNote(s.host, "inbox/One.md");
    s.answer("Renamed");
    expect(await renaming).toBe("completed");
    expect(s.useStore.getState().vaultTasks[0].rawText).toContain(
      "[[Renamed]]",
    );
  } finally {
    marker.remove();
  }
});

describe("note lifecycle saves", () => {
  it.each(["archive", "trash"] as const)(
    "saves edits made during %s before closing the note",
    async (action) => {
      const s = await setup(),
        gate = deferred();
      const method =
        action === "archive" ? s.bridge.archiveNote : s.bridge.moveToTrash;
      method.mockImplementation(async (path) => {
        await gate.promise;
        return s.relocate(path, `${action}/One 2.md`);
      });
      const changing = s.useStore
        .getState()
        .changeNoteLifecycle("inbox/One.md", action, () => true);
      await vi.waitFor(() => expect(method).toHaveBeenCalled());
      s.useStore
        .getState()
        .updateNoteBody("inbox/One.md", "Late edit: café 日本語.  \n");
      gate.resolve();
      await changing;
      expect(s.files.get(`${action}/One 2.md`)).toBe(
        "Late edit: café 日本語.  \n",
      );
      expect(s.files.has("inbox/One.md")).toBe(false);
      expect(
        s.useStore.getState().noteContents[`${action}/One 2.md`],
      ).toBeUndefined();
      expect(s.useStore.getState().selectedPath).not.toBe(`${action}/One 2.md`);
    },
  );

  it("keeps the destination buffer open and dirty when saving after archive fails", async () => {
    const s = await setup(),
      gate = deferred();
    vi.spyOn(console, "error").mockImplementation(() => {});
    s.bridge.archiveNote.mockImplementation(async (path) => {
      await gate.promise;
      return s.relocate(path, "archive/One.md");
    });
    const changing = s.useStore
      .getState()
      .changeNoteLifecycle("inbox/One.md", "archive", () => true);
    const failed = expect(changing).rejects.toThrow("unsaved changes");
    await vi.waitFor(() => expect(s.bridge.archiveNote).toHaveBeenCalled());
    s.useStore.getState().updateNoteBody("inbox/One.md", "Keep this draft.\n");
    s.bridge.writeNote.mockRejectedValue(new Error("disk full"));
    gate.resolve();
    await failed;
    expect(s.useStore.getState().selectedPath).toBe("archive/One.md");
    expect(s.useStore.getState().noteContents["archive/One.md"].body).toBe(
      "Keep this draft.\n",
    );
    expect(s.useStore.getState().noteDirty["archive/One.md"]).toBe(true);
  });

  it.each(["archive", "trash"] as const)(
    "restores a %s note to the canonical path and keeps its tab",
    async (folder) => {
      const s = await setup();
      const path = `${folder}/One.md`,
        body = "Restore exact bytes.  \n";
      s.files.set(path, body);
      const leaf = makeLeaf([path], path);
      s.useStore.setState({
        notes: [s.metadata(path)],
        paneLayout: leaf,
        activePaneId: leaf.id,
        selectedPath: path,
        noteContents: { [path]: { ...s.metadata(path), body } },
        noteDirty: {},
      });
      await s.useStore
        .getState()
        .changeNoteLifecycle(path, "restore", () => true);
      expect(s.useStore.getState().selectedPath).toBe("inbox/One.md");
      expect(s.files.get("inbox/One.md")).toBe(body);
      expect(s.files.has(path)).toBe(false);
    },
  );

  it("retains the source buffer when the host refuses a lifecycle move", async () => {
    const s = await setup();
    s.bridge.archiveNote.mockRejectedValue(new Error("permission denied"));
    await expect(
      s.useStore
        .getState()
        .changeNoteLifecycle("inbox/One.md", "archive", () => true),
    ).rejects.toThrow("permission denied");
    expect(s.useStore.getState().selectedPath).toBe("inbox/One.md");
    expect(s.files.has("inbox/One.md")).toBe(true);
  });
});

describe("irreversible note lifecycle", () => {
  it.each(["delete", "system-trash"] as const)(
    "freezes every editor for %s until it commits",
    async (action) => {
      const s = await setup(),
        gate = deferred();
      const { EditorState } = await import("@codemirror/state");
      const { EditorView } = await import("@codemirror/view");
      const { noteEditingLockExtension } =
        await import("./lib/note-lifecycle-lock");
      if (action === "system-trash")
        s.useStore.setState({
          vault: { ...s.useStore.getState().vault!, temporary: true },
        });
      const views = [
        "inbox/One.md",
        "inbox/One.md",
        "inbox/One.md",
        "inbox/Other.md",
      ].map(
        (path) =>
          new EditorView({
            state: EditorState.create({
              doc: s.files.get(path),
              extensions: [
                noteEditingLockExtension(() => ({
                  vault: s.useStore.getState().vault,
                  path,
                })),
              ],
            }),
            parent: document.body,
          }),
      );
      const method =
        action === "delete" ? s.bridge.deleteNote : s.bridge.moveToTrash;
      if (action === "delete")
        s.bridge.deleteNote.mockImplementation(async (path) => {
          await gate.promise;
          s.files.delete(path);
        });
      else
        s.bridge.moveToTrash.mockImplementation(async (path) => {
          await gate.promise;
          s.files.delete(path);
          return s.metadata(path);
        });
      s.useStore
        .getState()
        .updateNoteBody("inbox/One.md", "Save before deleting.\n");
      try {
        const operation = s.useStore
          .getState()
          .changeNoteLifecycle(
            "inbox/One.md",
            action === "delete" ? "delete" : "trash",
            () => true,
          );
        for (const view of views.slice(0, 3)) {
          expect(view.state.readOnly).toBe(true);
          const before = view.state.doc.toString();
          view.dispatch({ changes: { from: 0, insert: "Rejected" } });
          expect(view.state.doc.toString()).toBe(before);
        }
        expect(views[3].state.readOnly).toBe(false);
        s.useStore
          .getState()
          .updateNoteBody("inbox/One.md", "Rejected late edit");
        await vi.waitFor(() => expect(method).toHaveBeenCalled());
        expect(s.files.get("inbox/One.md")).toBe("Save before deleting.\n");
        gate.resolve();
        await operation;
        await s.useStore.getState().flushDirtyNotes();
        expect(s.files.has("inbox/One.md")).toBe(false);
        expect(
          s.useStore.getState().noteContents["inbox/One.md"],
        ).toBeUndefined();
        for (const view of views) expect(view.state.readOnly).toBe(false);
      } finally {
        gate.resolve();
        views.forEach((view) => view.destroy());
      }
    },
  );

  it("unlocks after host failure and accepts the next edit", async () => {
    const s = await setup();
    s.bridge.deleteNote.mockRejectedValue(new Error("denied"));
    await expect(
      s.useStore.getState().changeNoteLifecycle("inbox/One.md", "delete"),
    ).rejects.toThrow("denied");
    s.useStore.getState().updateNoteBody("inbox/One.md", "Editable again.\n");
    await s.useStore.getState().flushDirtyNotes();
    expect(s.files.get("inbox/One.md")).toBe("Editable again.\n");
    expect(s.useStore.getState().selectedPath).toBe("inbox/One.md");
  });

  it("does not delete after the initial save fails", async () => {
    const s = await setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    s.useStore.getState().updateNoteBody("inbox/One.md", "Keep draft.\n");
    s.bridge.writeNote.mockRejectedValue(new Error("disk full"));
    await expect(
      s.useStore.getState().changeNoteLifecycle("inbox/One.md", "delete"),
    ).rejects.toThrow();
    expect(s.bridge.deleteNote).not.toHaveBeenCalled();
    expect(s.useStore.getState().noteContents["inbox/One.md"].body).toBe(
      "Keep draft.\n",
    );
    expect(s.useStore.getState().noteDirty["inbox/One.md"]).toBe(true);
    s.bridge.writeNote.mockImplementation(async (path, body) => {
      s.files.set(path, body);
      return s.metadata(path);
    });
    await s.useStore.getState().flushDirtyNotes();
  });
});

describe("public note lifecycle", () => {
  it("saves edits made while confirmation is open and restores exact bytes", async () => {
    const s = await publicSetup();
    const trashing = s.requestTrashNote(s.host, "inbox/One.md");
    expect(s.getConfirmRequest()?.options.confirmLabel).toBe("Move to Trash");
    s.useStore
      .getState()
      .updateNoteBody("inbox/One.md", "Confirmed draft café.  \n");
    s.confirm(true);
    expect(await trashing).toBe("completed");
    expect(s.files.get("trash/One.md")).toBe("Confirmed draft café.  \n");
    expect(await s.restoreNote(s.host, "trash/One.md")).toBe("completed");
    expect(s.files.get("inbox/One.md")).toBe("Confirmed draft café.  \n");
  });

  it("cancels and rejects stale confirmations without touching the host", async () => {
    const s = await publicSetup();
    let current = true;
    const host = { isCurrent: () => current };
    const cancelled = s.requestTrashNote(host, "inbox/One.md");
    s.confirm(false);
    expect(await cancelled).toBe("cancelled");
    const stale = s.requestTrashNote(host, "inbox/One.md");
    current = false;
    s.confirm(true);
    expect(await stale).toBe("stale");
    expect(s.bridge.moveToTrash).not.toHaveBeenCalled();
  });

  it("only offers permanent deletion for trashed ordinary notes", async () => {
    const s = await publicSetup();
    expect(await s.requestDeleteNotePermanently(s.host, "inbox/One.md")).toBe(
      "unavailable",
    );
    const trashing = s.requestTrashNote(s.host, "inbox/One.md");
    s.confirm(true);
    await trashing;
    const deleting = s.requestDeleteNotePermanently(s.host, "trash/One.md");
    expect(s.getConfirmRequest()?.options.danger).toBe(true);
    s.confirm(true);
    expect(await deleting).toBe("completed");
    expect(s.files.has("trash/One.md")).toBe(false);
  });

  it("toggles a note in and out of Favorites and persists the list (#810)", async () => {
    const s = await publicSetup();
    expect(await s.requestToggleNoteFavorite(s.host, "inbox/One.md")).toBe(
      "completed",
    );
    expect(s.useStore.getState().vaultSettings.favorites).toEqual([
      "inbox/One.md",
    ]);
    expect(s.bridge.setVaultSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ favorites: ["inbox/One.md"] }),
    );
    expect(await s.requestToggleNoteFavorite(s.host, "inbox/One.md")).toBe(
      "completed",
    );
    expect(s.useStore.getState().vaultSettings.favorites).toEqual([]);
  });

  it("keeps trashed and unknown notes out of Favorites, like the sidebar menu", async () => {
    const s = await publicSetup();
    const trashing = s.requestTrashNote(s.host, "inbox/One.md");
    s.confirm(true);
    await trashing;
    s.bridge.setVaultSettings.mockClear();
    expect(await s.requestToggleNoteFavorite(s.host, "trash/One.md")).toBe(
      "unavailable",
    );
    expect(await s.requestToggleNoteFavorite(s.host, "missing.md")).toBe(
      "unavailable",
    );
    expect(
      await s.requestToggleNoteFavorite(
        { isCurrent: () => false },
        "inbox/Other.md",
      ),
    ).toBe("unavailable");
    expect(s.bridge.setVaultSettings).not.toHaveBeenCalled();
    expect(s.useStore.getState().vaultSettings.favorites).toEqual([]);
  });

  it("archives and unarchives through the public boundary", async () => {
    const s = await publicSetup();
    expect(await s.requestArchiveNote(s.host, "inbox/One.md")).toBe(
      "completed",
    );
    expect(await s.requestArchiveNote(s.host, "archive/One.md")).toBe(
      "unavailable",
    );
    expect(await s.restoreNote(s.host, "archive/One.md")).toBe("completed");
  });

  it("keeps other editor restrictions when the deletion lock is removed", async () => {
    const { EditorState } = await import("@codemirror/state");
    const { EditorView } = await import("@codemirror/view");
    const { lockNoteEditing, noteEditingLockExtension } =
      await import("./lib/note-lifecycle-lock");
    const vault = {},
      path = "note.md";
    const view = new EditorView({
      state: EditorState.create({
        doc: "Body",
        extensions: [
          noteEditingLockExtension(() => ({ vault, path })),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      }),
      parent: document.body,
    });
    try {
      expect(view.state.facet(EditorView.editable)).toBe(false);
      const unlock = lockNoteEditing(vault, path);
      unlock();
      expect(view.state.readOnly).toBe(true);
      expect(view.state.facet(EditorView.editable)).toBe(false);
    } finally {
      view.destroy();
    }
  });
});

it("waits for an IME composition to finish before deleting", async () => {
  const s = await setup();
  const { EditorState } = await import("@codemirror/state");
  const { EditorView } = await import("@codemirror/view");
  const { noteEditingLockExtension } =
    await import("./lib/note-lifecycle-lock");
  const view = new EditorView({
    state: EditorState.create({
      doc: "Body",
      extensions: [
        noteEditingLockExtension(() => ({
          vault: s.useStore.getState().vault,
          path: "inbox/One.md",
        })),
      ],
    }),
    parent: document.body,
  });
  Object.defineProperty(view, "composing", { get: () => true });
  try {
    await expect(
      s.useStore.getState().changeNoteLifecycle("inbox/One.md", "delete"),
    ).rejects.toThrow("Finish entering text");
    expect(s.bridge.deleteNote).not.toHaveBeenCalled();
    expect(view.state.readOnly).toBe(false);
  } finally {
    view.destroy();
  }
});

it("does not claim system Trash succeeded if its token changes while saving", async () => {
  const s = await setup(),
    gate = deferred();
  let current = true;
  const { useToastStore } = await import("./lib/toast");
  s.useStore.setState({
    vault: { ...s.useStore.getState().vault!, temporary: true },
  });
  s.useStore
    .getState()
    .updateNoteBody("inbox/One.md", "Saved before switching.\n");
  s.bridge.writeNote.mockImplementation(async (path, body) => {
    await gate.promise;
    s.files.set(path, body);
    return s.metadata(path);
  });
  const deleting = s.useStore
    .getState()
    .changeNoteLifecycle("inbox/One.md", "trash", () => current);
  await vi.waitFor(() => expect(s.bridge.writeNote).toHaveBeenCalled());
  current = false;
  gate.resolve();
  await deleting;
  expect(s.bridge.moveToTrash).not.toHaveBeenCalled();
  expect(s.files.has("inbox/One.md")).toBe(true);
  expect(
    useToastStore
      .getState()
      .toasts.some((toast) => toast.message.includes("Moved to system Trash")),
  ).toBe(false);
});

it("finishes saving a dispatched trash operation in its original vault after its host token changes", async () => {
  const s = await publicSetup(),
    gate = deferred();
  let current = true;
  s.bridge.moveToTrash.mockImplementation(async (path) => {
    await gate.promise;
    return s.relocate(path, "trash/One 2.md");
  });
  const trashing = s.requestTrashNote(
    { isCurrent: () => current },
    "inbox/One.md",
  );
  s.confirm(true);
  await vi.waitFor(() => expect(s.bridge.moveToTrash).toHaveBeenCalled());
  current = false;
  s.useStore
    .getState()
    .updateNoteBody("inbox/One.md", "Late edit before vault switch.\n");
  gate.resolve();
  expect(await trashing).toBe("stale");
  expect(s.files.get("trash/One 2.md")).toBe(
    "Late edit before vault switch.\n",
  );
  expect(s.useStore.getState().noteContents["trash/One 2.md"]).toBeUndefined();
  expect(s.files.has("inbox/One.md")).toBe(false);
});

it('stops a bulk trash after failure and reports completed source paths', async () => {
  const s = await publicSetup()
  s.bridge.moveToTrash.mockImplementation(async path => {
    if (path.endsWith('Other.md')) throw new Error('Second move refused')
    return s.relocate(path, 'trash/One.md')
  })
  s.useStore.getState().updateNoteBody('inbox/Other.md', 'Keep the second draft.\n')
  const batch = s.requestNoteBatch(s.host, ['inbox/One.md','inbox/Other.md'], 'trash')
  const failure = expect(batch).rejects.toMatchObject({name:'NoteBatchError',completed:['inbox/One.md'],unconfirmed:['inbox/Other.md']})
  s.confirm(true)
  await failure
  expect(s.files.has('trash/One.md')).toBe(true)
  expect(s.files.get('inbox/Other.md')).toBe('Keep the second draft.\n')
  expect(s.useStore.getState().noteContents['inbox/Other.md'].body).toBe('Keep the second draft.\n')
})

it('deduplicates a confirmed batch and cancels the whole selection together', async () => {
  const s=await publicSetup()
  const cancelled=s.requestNoteBatch(s.host,['inbox/One.md','inbox/Other.md'],'trash')
  s.confirm(false)
  expect((await cancelled).status).toBe('cancelled')
  expect(s.bridge.moveToTrash).not.toHaveBeenCalled()
  const batch=s.requestNoteBatch(s.host,['inbox/One.md','inbox/One.md'],'trash')
  s.confirm(true)
  expect(await batch).toEqual({status:'completed',completed:['inbox/One.md'],unconfirmed:[]})
  expect(s.bridge.moveToTrash).toHaveBeenCalledTimes(1)
})

it('stops a batch if its host token changes after dispatch',async()=>{
  const s=await publicSetup()
  let current=true
  s.bridge.archiveNote.mockImplementation(async path=>{current=false;return s.relocate(path,'archive/One.md')})
  const result=await s.requestNoteBatch({isCurrent:()=>current},['inbox/One.md','inbox/Other.md'],'archive')
  expect(result.status).toBe('stale')
  expect(s.bridge.archiveNote).toHaveBeenCalledTimes(1)
  expect(s.files.has('inbox/Other.md')).toBe(true)
  expect(s.files.has('archive/One.md')).toBe(true)
})

it('saves and freezes all notes in remapped Trash before emptying it',async()=>{
  const s=await publicSetup(),gate=deferred()
  const emptyTrash=vi.fn(async()=>{expect(s.files.get('Bin/Nested/One.md')).toBe('Saved draft.\n');await gate.promise;for(const path of s.files.keys())if(path.startsWith('Bin/'))s.files.delete(path)})
  Object.assign(s.bridge,{emptyTrash})
  s.files.set('Bin/Nested/One.md','Original')
  const note={...s.metadata('Bin/Nested/One.md'),folder:'trash' as const,body:'Original'}
  s.useStore.setState({vaultSettings:{...s.useStore.getState().vaultSettings,systemFolderPaths:{trash:'Bin'}},notes:[...s.useStore.getState().notes,note],noteContents:{...s.useStore.getState().noteContents,[note.path]:note}})
  s.useStore.getState().updateNoteBody(note.path,'Saved draft.\n')
  const emptying=s.requestEmptyTrash(s.host)
  s.confirm(true)
  await vi.waitFor(()=>expect(emptyTrash).toHaveBeenCalled())
  s.useStore.getState().updateNoteBody(note.path,'Rejected edit')
  expect(s.useStore.getState().noteContents[note.path].body).toBe('Saved draft.\n')
  s.useStore.getState().updateNoteBody('inbox/Other.md','Still editable.\n')
  gate.resolve()
  expect(await emptying).toBe('completed')
  await s.useStore.getState().flushDirtyNotes()
  expect(s.files.has(note.path)).toBe(false)
  expect(s.useStore.getState().noteContents[note.path]).toBeUndefined()
  expect(s.files.get('inbox/Other.md')).toBe('Still editable.\n')
})

it('keeps Trash editors available when emptying fails',async()=>{
  const s=await publicSetup()
  Object.assign(s.bridge,{emptyTrash:vi.fn(async()=>{throw new Error('denied')})})
  s.files.set('trash/One.md','Keep me')
  const note={...s.metadata('trash/One.md'),body:'Keep me'}
  s.useStore.setState({notes:[note],noteContents:{[note.path]:note}})
  const emptying=s.requestEmptyTrash(s.host)
  const rejected=expect(emptying).rejects.toThrow('denied')
  s.confirm(true)
  await rejected
  s.useStore.getState().updateNoteBody(note.path,'Editable after failure')
  await s.useStore.getState().flushDirtyNotes()
  expect(s.files.get(note.path)).toBe('Editable after failure')
})

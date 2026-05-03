export type KeymapKind = "shortcut" | "sequence";
export type KeymapScope =
  | "app"
  | "leader"
  | "pane"
  | "vim-editor"
  | "lists"
  | "views";
export type KeymapGroup = "global" | "vim" | "navigation" | "view-actions";

export type KeymapId =
  | "global.searchNotes"
  | "global.searchNotesNonVim"
  | "global.commandPalette"
  | "global.newQuickNote"
  | "global.openQuickCapture"
  | "global.openSettings"
  | "global.toggleSidebar"
  | "global.toggleConnections"
  | "global.toggleOutlinePanel"
  | "global.modeEdit"
  | "global.modeSplit"
  | "global.modePreview"
  | "global.toggleZenMode"
  | "global.closeActiveTab"
  | "global.toggleWordWrap"
  | "global.exportNotePdf"
  | "global.zoomIn"
  | "global.zoomOut"
  | "global.zoomReset"
  | "vim.leaderPrefix"
  | "vim.leaderOpenBuffers"
  | "vim.leaderSearchNotes"
  | "vim.leaderSearchVaultText"
  | "vim.leaderToggleSidebar"
  | "vim.leaderNoteOutline"
  | "vim.leaderNoteActions"
  | "vim.leaderFormatNote"
  | "vim.leaderQuickCapture"
  | "vim.panePrefix"
  | "vim.paneFocusLeft"
  | "vim.paneFocusDown"
  | "vim.paneFocusUp"
  | "vim.paneFocusRight"
  | "vim.paneSplitRight"
  | "vim.paneSplitDown"
  | "vim.historyBack"
  | "vim.historyForward"
  | "vim.hintMode"
  | "vim.goToDefinition"
  | "vim.foldCurrent"
  | "vim.unfoldCurrent"
  | "vim.foldAll"
  | "vim.unfoldAll"
  | "nav.moveDown"
  | "nav.moveUp"
  | "nav.jumpTop"
  | "nav.jumpBottom"
  | "nav.halfPageDown"
  | "nav.halfPageUp"
  | "nav.openSideItem"
  | "nav.openResult"
  | "nav.back"
  | "nav.toggleFolder"
  | "nav.filter"
  | "nav.contextMenu"
  | "nav.peekPreview"
  | "nav.restore"
  | "nav.delete"
  | "nav.toggleTask"
  | "nav.localEx"
  | "nav.newQuickNote"
  | "nav.unarchive";

export type KeymapOverrides = Partial<Record<KeymapId, string>>;

export interface KeymapDefinition {
  id: KeymapId;
  kind: KeymapKind;
  scope: KeymapScope;
  group: KeymapGroup;
  title: string;
  description: string;
  defaultBinding: string;
  vimOnly?: boolean;
  nonVimOnly?: boolean;
  maxTokens?: number;
}

const KEYMAP_DEFINITIONS: KeymapDefinition[] = [
  {
    id: "global.searchNotes",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Search notes",
    description: "Open the vault-wide note search palette.",
    defaultBinding: "Mod+P",
  },
  {
    id: "global.searchNotesNonVim",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Search notes in non-Vim mode",
    description: "Extra direct search shortcut when Vim mode is off.",
    defaultBinding: "Mod+F",
    nonVimOnly: true,
  },
  {
    id: "global.commandPalette",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Open command palette",
    description: "Open the command palette.",
    defaultBinding: "Shift+Mod+P",
  },
  {
    id: "global.newQuickNote",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "New quick note",
    description: "Create a quick capture note and focus its title.",
    defaultBinding: "Shift+Mod+N",
  },
  {
    id: "global.openQuickCapture",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Open quick capture window",
    description:
      "Open the floating capture window. Also bound system-wide; configure that hotkey under Settings → Editor.",
    defaultBinding: "Shift+Mod+Space",
  },
  {
    id: "global.openSettings",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Open settings",
    description: "Open the Settings modal.",
    defaultBinding: "Mod+,",
  },
  {
    id: "global.toggleSidebar",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Toggle sidebar",
    description: "Hide or show the left sidebar.",
    defaultBinding: "Mod+1",
  },
  {
    id: "global.toggleConnections",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Toggle connections panel",
    description: "Toggle the connections panel in the active pane.",
    defaultBinding: "Mod+2",
  },
  {
    id: "global.toggleOutlinePanel",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Toggle outline panel",
    description: "Toggle the outline panel in the active pane.",
    defaultBinding: "Mod+3",
  },
  {
    id: "global.modeEdit",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Switch to editor mode",
    description: "Show only the markdown editor for the active note.",
    defaultBinding: "Mod+4",
  },
  {
    id: "global.modeSplit",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Switch to split mode",
    description: "Show the editor and rendered preview side by side.",
    defaultBinding: "Mod+5",
  },
  {
    id: "global.modePreview",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Switch to preview mode",
    description: "Show only the rendered preview for the active note.",
    defaultBinding: "Mod+6",
  },
  {
    id: "global.toggleZenMode",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Toggle Zen mode",
    description: "Hide or restore the app chrome.",
    defaultBinding: "Mod+.",
  },
  {
    id: "global.closeActiveTab",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Close active tab",
    description: "Close the current note or virtual tab.",
    defaultBinding: "Mod+W",
  },
  {
    id: "global.toggleWordWrap",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Toggle word wrap",
    description: "Switch between wrapped lines and horizontal scrolling.",
    defaultBinding: "Alt+Z",
  },
  {
    id: "global.exportNotePdf",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Export note as PDF",
    description: "Export the active note as a PDF file.",
    defaultBinding: "Shift+Mod+E",
  },
  {
    id: "global.zoomIn",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Zoom in",
    description: "Increase the app zoom factor.",
    defaultBinding: "Mod+=",
  },
  {
    id: "global.zoomOut",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Zoom out",
    description: "Decrease the app zoom factor.",
    defaultBinding: "Mod+-",
  },
  {
    id: "global.zoomReset",
    kind: "shortcut",
    scope: "app",
    group: "global",
    title: "Reset zoom",
    description: "Restore the app zoom factor to its default size.",
    defaultBinding: "Mod+0",
  },
  {
    id: "vim.leaderPrefix",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader key",
    description: "Start leader mode and leader hints.",
    defaultBinding: "Space",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderOpenBuffers",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: open buffers",
    description: "Open the buffer switcher.",
    defaultBinding: "o",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderSearchNotes",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: search notes",
    description: "Open note search from any panel.",
    defaultBinding: "f",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderSearchVaultText",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: search vault text",
    description: "Open fuzzy vault text search across note contents.",
    defaultBinding: "s t",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.leaderToggleSidebar",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: toggle sidebar",
    description: "Show or hide the left sidebar.",
    defaultBinding: "e",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderNoteOutline",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: note outline",
    description: "Open the note outline palette.",
    defaultBinding: "p",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderNoteActions",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: note actions",
    description: "Open the note-local leader group.",
    defaultBinding: "l",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderFormatNote",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader note action: format note",
    description: "Format the active note from the editor.",
    defaultBinding: "f",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.leaderQuickCapture",
    kind: "sequence",
    scope: "leader",
    group: "vim",
    title: "Leader: open quick capture",
    description: "Open the floating quick capture window.",
    defaultBinding: "q",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.panePrefix",
    kind: "sequence",
    scope: "pane",
    group: "vim",
    title: "Pane command prefix",
    description: "Start pane focus and split commands.",
    defaultBinding: "Ctrl+W",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.paneFocusLeft",
    kind: "sequence",
    scope: "pane",
    group: "vim",
    title: "Pane: focus left",
    description: "Move focus to the panel or pane on the left.",
    defaultBinding: "h",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.paneFocusDown",
    kind: "sequence",
    scope: "pane",
    group: "vim",
    title: "Pane: focus down",
    description: "Move focus to the panel or pane below.",
    defaultBinding: "j",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.paneFocusUp",
    kind: "sequence",
    scope: "pane",
    group: "vim",
    title: "Pane: focus up",
    description: "Move focus to the panel or pane above.",
    defaultBinding: "k",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.paneFocusRight",
    kind: "sequence",
    scope: "pane",
    group: "vim",
    title: "Pane: focus right",
    description: "Move focus to the panel or pane on the right.",
    defaultBinding: "l",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.paneSplitRight",
    kind: "sequence",
    scope: "pane",
    group: "vim",
    title: "Pane: split right",
    description: "Clone the current tab into a pane on the right.",
    defaultBinding: "v",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.paneSplitDown",
    kind: "sequence",
    scope: "pane",
    group: "vim",
    title: "Pane: split down",
    description: "Clone the current tab into a pane below.",
    defaultBinding: "s",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.historyBack",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Go back in note history",
    description: "Jump to the previous note location in history.",
    defaultBinding: "Ctrl+O",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.historyForward",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Go forward in note history",
    description: "Jump forward in note history.",
    defaultBinding: "Ctrl+I",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.hintMode",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Hint mode",
    description: "Show jump labels for clickable targets.",
    defaultBinding: "f",
    vimOnly: true,
    maxTokens: 1,
  },
  {
    id: "vim.goToDefinition",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Follow link at cursor",
    description: "Open the note, URL, or asset under the cursor.",
    defaultBinding: "g d",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.foldCurrent",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Fold heading at cursor",
    description: "Collapse the heading section at the cursor.",
    defaultBinding: "z c",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.unfoldCurrent",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Unfold heading at cursor",
    description: "Expand the heading section at the cursor.",
    defaultBinding: "z o",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.foldAll",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Fold all headings",
    description: "Collapse every heading section in the note.",
    defaultBinding: "z M",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "vim.unfoldAll",
    kind: "sequence",
    scope: "vim-editor",
    group: "vim",
    title: "Unfold all headings",
    description: "Expand every heading section in the note.",
    defaultBinding: "z R",
    vimOnly: true,
    maxTokens: 2,
  },
  {
    id: "nav.moveDown",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Move selection down",
    description: "Move the current row cursor or panel selection down.",
    defaultBinding: "j",
    maxTokens: 1,
  },
  {
    id: "nav.moveUp",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Move selection up",
    description: "Move the current row cursor or panel selection up.",
    defaultBinding: "k",
    maxTokens: 1,
  },
  {
    id: "nav.jumpTop",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Jump to top",
    description:
      "Jump to the first visible row or to the top of preview content.",
    defaultBinding: "g g",
    maxTokens: 2,
  },
  {
    id: "nav.jumpBottom",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Jump to bottom",
    description:
      "Jump to the last visible row or to the bottom of preview content.",
    defaultBinding: "G",
    maxTokens: 1,
  },
  {
    id: "nav.halfPageDown",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Half-page down",
    description: "Scroll preview content down by half a viewport.",
    defaultBinding: "Ctrl+d",
    maxTokens: 1,
  },
  {
    id: "nav.halfPageUp",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Half-page up",
    description: "Scroll preview content up by half a viewport.",
    defaultBinding: "Ctrl+u",
    maxTokens: 1,
  },
  {
    id: "nav.openSideItem",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Open sidebar or note-list item",
    description: "Open the current sidebar or note-list selection.",
    defaultBinding: "l",
    maxTokens: 1,
  },
  {
    id: "nav.openResult",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Open result",
    description: "Open the selected note or result in a view.",
    defaultBinding: "o",
    maxTokens: 1,
  },
  {
    id: "nav.back",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Back out",
    description: "Collapse, move left, or return focus toward the editor.",
    defaultBinding: "h",
    maxTokens: 1,
  },
  {
    id: "nav.toggleFolder",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Toggle folder",
    description: "Expand or collapse the current sidebar folder.",
    defaultBinding: "o",
    maxTokens: 1,
  },
  {
    id: "nav.filter",
    kind: "sequence",
    scope: "lists",
    group: "navigation",
    title: "Focus filter or search",
    description:
      "Focus the local filter or open note search from panel navigation.",
    defaultBinding: "/",
    maxTokens: 1,
  },
  {
    id: "nav.contextMenu",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Open context menu",
    description: "Open the contextual actions menu for the current row.",
    defaultBinding: "m",
    maxTokens: 1,
  },
  {
    id: "nav.peekPreview",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Peek preview",
    description: "Open the hover preview for the selected connection.",
    defaultBinding: "p",
    maxTokens: 1,
  },
  {
    id: "nav.restore",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Restore trashed note",
    description: "Restore the selected trashed note.",
    defaultBinding: "r",
    maxTokens: 1,
  },
  {
    id: "nav.delete",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Delete selected result",
    description:
      "Permanently delete or move the selected item to trash, depending on the view.",
    defaultBinding: "x",
    maxTokens: 1,
  },
  {
    id: "nav.toggleTask",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Toggle task",
    description: "Check or uncheck the selected task.",
    defaultBinding: "x",
    maxTokens: 1,
  },
  {
    id: "nav.localEx",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Open local ex prompt",
    description: "Open the view-specific ex prompt in Tasks or Tags.",
    defaultBinding: ":",
    maxTokens: 1,
  },
  {
    id: "nav.newQuickNote",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "New quick note from Quick Notes view",
    description: "Create a new quick note from the Quick Notes list tab.",
    defaultBinding: "n",
    maxTokens: 1,
  },
  {
    id: "nav.unarchive",
    kind: "sequence",
    scope: "views",
    group: "view-actions",
    title: "Unarchive selected note",
    description: "Move the selected archived note back to Inbox.",
    defaultBinding: "u",
    maxTokens: 1,
  },
];

for (const definition of KEYMAP_DEFINITIONS) {
  const normalized =
    definition.kind === "shortcut"
      ? normalizeShortcutBinding(definition.defaultBinding)
      : normalizeSequenceBinding(definition.defaultBinding);
  if (normalized) definition.defaultBinding = normalized;
}

const KEYMAP_INDEX = new Map<KeymapId, KeymapDefinition>(
  KEYMAP_DEFINITIONS.map((definition) => [definition.id, definition] as const),
);

const KEYMAP_GROUP_LABELS: Record<KeymapGroup, string> = {
  global: "Global shortcuts",
  vim: "Vim-specific shortcuts",
  navigation: "Navigation",
  "view-actions": "View-specific actions",
};

export function getKeymapDefinitions(): KeymapDefinition[] {
  return KEYMAP_DEFINITIONS.slice();
}

export function getKeymapDefinition(id: KeymapId): KeymapDefinition {
  const definition = KEYMAP_INDEX.get(id);
  if (!definition) throw new Error(`Unknown keymap id: ${id}`);
  return definition;
}

export function getKeymapGroupLabel(group: KeymapGroup): string {
  return KEYMAP_GROUP_LABELS[group];
}

export function getDefaultKeymapBinding(id: KeymapId): string {
  return getKeymapDefinition(id).defaultBinding;
}

export function getKeymapBinding(
  overrides: KeymapOverrides | null | undefined,
  id: KeymapId,
): string {
  const override = overrides?.[id];
  return override || getDefaultKeymapBinding(id);
}

export function getSequenceTokens(
  overrides: KeymapOverrides | null | undefined,
  id: KeymapId,
): string[] {
  return getKeymapBinding(overrides, id)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

type RuntimeZenApi = { platformSync?: () => NodeJS.Platform };

function getRuntimePlatform(): NodeJS.Platform | null {
  if (typeof window !== "undefined") {
    const zen = (window as Window & { zen?: RuntimeZenApi }).zen;
    if (typeof zen?.platformSync === "function") {
      return zen.platformSync();
    }
  }
  if (typeof process !== "undefined" && typeof process.platform === "string") {
    return process.platform as NodeJS.Platform;
  }
  return null;
}

export function isMacPlatform(): boolean {
  const runtimePlatform = getRuntimePlatform();
  if (runtimePlatform) return runtimePlatform === "darwin";
  if (typeof navigator === "undefined") return true;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
}

function isModifierKey(key: string): boolean {
  return (
    key === "Shift" || key === "Control" || key === "Alt" || key === "Meta"
  );
}

function physicalKeyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  switch (code) {
    case "Minus":
      return "-";
    case "Equal":
      return "=";
    case "BracketLeft":
      return "[";
    case "BracketRight":
      return "]";
    case "Backslash":
      return "\\";
    case "Semicolon":
      return ";";
    case "Quote":
      return "'";
    case "Comma":
      return ",";
    case "Period":
      return ".";
    case "Slash":
      return "/";
    case "Backquote":
      return "`";
    case "NumpadAdd":
      return "+";
    case "NumpadSubtract":
      return "-";
    case "NumpadMultiply":
      return "*";
    case "NumpadDivide":
      return "/";
    case "NumpadDecimal":
      return ".";
    default:
      return null;
  }
}

/**
 * Resolve the binding key from a KeyboardEvent.
 *
 * Layout-aware: when `event.key` is a single printable ASCII char it
 * reflects what the active keyboard layout *typed* (Colemak/Dvorak
 * users want `Cmd+P` to fire on whichever physical key produces `p`,
 * not on the QWERTY-P position). Letters are uppercased so binding
 * comparison is case-insensitive (Shift state is encoded separately).
 *
 * Falls back to `event.code` (physical position) when `event.key` is
 * unusable. On macOS, Alt-bearing combos like Option+J or Hyper
 * (=⌃⌥⇧⌘)+J produce transformed glyphs (`ˆ`, `Ô`, …) outside ASCII;
 * the fallback keeps Hyper+J recording as `J` so those bindings
 * round-trip cleanly.
 *
 * Returns `null` for modifier-only events, dead-key composition
 * (`event.key === 'Dead'`/`'Process'`), and special keys (Space, Tab,
 * Enter, F1–F24, arrows) — the caller resolves those via
 * `normalizeKeyName(event.key)`.
 */
function resolveKeyFromEvent(event: KeyboardEvent): string | null {
  if (isModifierKey(event.key)) return null;
  const k = event.key;
  // Skip the typed-char fast path for '+': it is the binding-string
  // separator, so emitting it would produce unparsable strings like
  // "Mod+Shift++". Fall through to physicalKeyFromCode (event.code
  // = "Equal" -> "=" for Shift+Cmd+=).
  if (k.length === 1 && k !== "+") {
    const cp = k.charCodeAt(0);
    if (cp > 0x20 && cp < 0x7f) {
      return k.toUpperCase();
    }
  }
  return physicalKeyFromCode(event.code);
}

function normalizeKeyName(key: string): string | null {
  if (!key) return null;
  if (isModifierKey(key)) return null;
  if (key === " ") return "Space";
  if (/^esc(?:ape)?$/i.test(key)) return "Escape";
  if (/^(return|enter)$/i.test(key)) return "Enter";
  if (/^tab$/i.test(key)) return "Tab";
  if (/^arrowup$/i.test(key)) return "ArrowUp";
  if (/^arrowdown$/i.test(key)) return "ArrowDown";
  if (/^arrowleft$/i.test(key)) return "ArrowLeft";
  if (/^arrowright$/i.test(key)) return "ArrowRight";
  if (key.length === 1) {
    if (/[A-Za-z]/.test(key)) return key.toUpperCase();
    return key;
  }
  return key;
}

function normalizeSequenceBaseToken(key: string): string | null {
  if (!key) return null;
  if (isModifierKey(key)) return null;
  if (key === " ") return "Space";
  if (/^esc(?:ape)?$/i.test(key)) return "Esc";
  if (/^(return|enter)$/i.test(key)) return "Enter";
  if (/^tab$/i.test(key)) return "Tab";
  if (/^arrowup$/i.test(key)) return "ArrowUp";
  if (/^arrowdown$/i.test(key)) return "ArrowDown";
  if (/^arrowleft$/i.test(key)) return "ArrowLeft";
  if (/^arrowright$/i.test(key)) return "ArrowRight";
  if (key.length === 1) return key;
  return key;
}

function normalizeModifierToken(
  modifier: string,
): "Ctrl" | "Alt" | "Shift" | "Meta" | "Mod" | null {
  if (/^(cmd|command|meta)$/i.test(modifier)) return "Meta";
  if (/^(ctrl|control)$/i.test(modifier)) return "Ctrl";
  if (/^(alt|option|opt)$/i.test(modifier)) return "Alt";
  if (/^shift$/i.test(modifier)) return "Shift";
  if (/^mod$/i.test(modifier)) return "Mod";
  return null;
}

function normalizeModifiers(parts: string[]): string[] {
  const order = ["Ctrl", "Alt", "Shift", "Mod", "Meta"];
  const unique = [...new Set(parts)];
  return unique.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

export function normalizeShortcutBinding(input: string): string | null {
  const mac = isMacPlatform();
  const parts = input
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const rawKey = parts.pop();
  if (!rawKey) return null;
  const key = normalizeKeyName(rawKey);
  if (!key) return null;
  const modifiers = normalizeModifiers(parts.flatMap((part) => {
    const normalized = normalizeModifierToken(part);
    if (!normalized) return [];
    // Canonicalize the platform-primary modifier to `Mod` so stored
    // shortcut bindings remain portable across the renderer and the
    // key recorder. Keep the non-primary modifier explicit.
    if (normalized === "Meta") return [mac ? "Mod" : "Meta"];
    if (normalized === "Ctrl") return [mac ? "Ctrl" : "Mod"];
    return [normalized];
  }));
  return [...modifiers, key].join("+");
}

export function normalizeSequenceToken(input: string): string | null {
  const parts = input
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const rawKey = parts.pop();
  if (!rawKey) return null;
  let base = normalizeSequenceBaseToken(rawKey);
  if (!base) return null;
  const modifiers = normalizeModifiers(
    parts
      .map((part) => normalizeModifierToken(part))
      .filter((part): part is NonNullable<typeof part> => !!part)
      .filter((part) => part !== "Mod"),
  );
  // When a non-Shift modifier (Ctrl/Alt/Meta) is combined with a single
  // ASCII letter, canonicalize to uppercase. Event-produced tokens come
  // out lowercase (e.g. Ctrl+w → `'w'` since Shift isn't held), but the
  // convention in default bindings and user-written keymaps is uppercase
  // (`'Ctrl+W'`). Matching them requires a consistent canonical form.
  if (
    base.length === 1 &&
    /[a-zA-Z]/.test(base) &&
    modifiers.some((m) => m === "Ctrl" || m === "Alt" || m === "Meta")
  ) {
    base = base.toUpperCase();
  }
  return modifiers.length > 0 ? `${modifiers.join("+")}+${base}` : base;
}

export function normalizeSequenceBinding(input: string): string | null {
  const tokens = input
    .split(/\s+/)
    .map((token) => normalizeSequenceToken(token))
    .filter((token): token is string => !!token);
  if (tokens.length === 0) return null;
  return tokens.join(" ");
}

export function normalizeKeymapBinding(
  id: KeymapId,
  input: string,
): string | null {
  const definition = getKeymapDefinition(id);
  const normalized =
    definition.kind === "shortcut"
      ? normalizeShortcutBinding(input)
      : normalizeSequenceBinding(input);
  if (!normalized) return null;
  if (definition.kind === "sequence" && definition.maxTokens) {
    const tokenCount = normalized.split(/\s+/).filter(Boolean).length;
    if (tokenCount > definition.maxTokens) {
      return normalized
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, definition.maxTokens)
        .join(" ");
    }
  }
  return normalized;
}

export function normalizeKeymapOverrides(input: unknown): KeymapOverrides {
  if (!input || typeof input !== "object") return {};
  const overrides: KeymapOverrides = {};
  for (const definition of KEYMAP_DEFINITIONS) {
    const raw = (input as Record<string, unknown>)[definition.id];
    if (typeof raw !== "string") continue;
    const normalized = normalizeKeymapBinding(definition.id, raw);
    if (normalized && normalized !== definition.defaultBinding) {
      overrides[definition.id] = normalized;
    }
  }
  return overrides;
}

export function shortcutBindingFromEvent(event: KeyboardEvent): string | null {
  const mac = isMacPlatform();
  const resolved = resolveKeyFromEvent(event);
  const key = resolved ?? normalizeKeyName(event.key);
  if (!key) return null;
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push(mac ? "Ctrl" : "Mod");
  if (event.metaKey) modifiers.push(mac ? "Mod" : "Meta");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return normalizeShortcutBinding([...modifiers, key].join("+"));
}

export function sequenceTokenFromEvent(event: KeyboardEvent): string | null {
  const resolved = resolveKeyFromEvent(event);
  // Sequence tokens are case-sensitive for letters (`<leader>q` vs
  // `<leader>Q` are different bindings). resolveKeyFromEvent returns
  // uppercase letters — fold them down so unmodified letters still
  // produce lowercase tokens, then promote to upper if Shift is held.
  let base: string | null
  if (resolved && /^[A-Z]$/.test(resolved)) {
    base = event.shiftKey ? resolved : resolved.toLowerCase()
  } else if (resolved) {
    base = resolved
  } else {
    base = normalizeSequenceBaseToken(event.key);
  }
  if (!base) return null;
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.metaKey) modifiers.push("Meta");
  if (event.shiftKey && base.length !== 1) modifiers.push("Shift");
  return normalizeSequenceToken(
    modifiers.length > 0 ? `${modifiers.join("+")}+${base}` : base,
  );
}

export function matchesShortcutBinding(
  event: KeyboardEvent,
  binding: string,
): boolean {
  const normalized = shortcutBindingFromEvent(event);
  return !!normalized && normalized === binding;
}

export function matchesShortcut(
  event: KeyboardEvent,
  overrides: KeymapOverrides | null | undefined,
  id: KeymapId,
): boolean {
  return matchesShortcutBinding(event, getKeymapBinding(overrides, id));
}

export function matchesSequenceToken(
  event: KeyboardEvent,
  overrides: KeymapOverrides | null | undefined,
  id: KeymapId,
): boolean {
  const tokens = getSequenceTokens(overrides, id);
  if (tokens.length !== 1) return false;
  const token = sequenceTokenFromEvent(event);
  return !!token && token === tokens[0];
}

export function formatKeyToken(token: string, mac = isMacPlatform()): string {
  if (token.includes("+")) {
    const parts = token.split("+");
    const base = parts.pop() ?? token;
    const prefix = parts
      .map((part) => formatKeyToken(part, mac))
      .join(mac ? "" : "+");
    return `${prefix}${mac ? "" : prefix ? "+" : ""}${formatKeyToken(base, mac)}`;
  }
  if (token === "Mod") return mac ? "⌘" : "Ctrl";
  if (token === "Meta") return mac ? "⌘" : "Meta";
  if (token === "Ctrl") return mac ? "⌃" : "Ctrl";
  if (token === "Alt") return mac ? "⌥" : "Alt";
  if (token === "Shift") return mac ? "⇧" : "Shift";
  if (token === "Escape" || token === "Esc") return "Esc";
  if (token === "Enter") return mac ? "↵" : "Enter";
  if (token === "Tab") return "Tab";
  if (token === "Space") return "Space";
  if (token === "ArrowUp") return "↑";
  if (token === "ArrowDown") return "↓";
  if (token === "ArrowLeft") return "←";
  if (token === "ArrowRight") return "→";
  return token;
}

export function formatKeymapBinding(binding: string, kind: KeymapKind): string {
  if (kind === "shortcut") {
    return formatKeyToken(binding);
  }
  return binding
    .split(/\s+/)
    .map((token) => formatKeyToken(token))
    .join(" ");
}

export function getKeymapDisplay(
  overrides: KeymapOverrides | null | undefined,
  id: KeymapId,
): string {
  const definition = getKeymapDefinition(id);
  return formatKeymapBinding(getKeymapBinding(overrides, id), definition.kind);
}

export function describeCurrentBinding(
  overrides: KeymapOverrides | null | undefined,
  id: KeymapId,
): string {
  return getKeymapDisplay(overrides, id);
}

export function getKeymapDefinitionsByGroup(): Array<{
  group: KeymapGroup;
  label: string;
  items: KeymapDefinition[];
}> {
  const groups: KeymapGroup[] = ["global", "vim", "navigation", "view-actions"];
  return groups.map((group) => ({
    group,
    label: getKeymapGroupLabel(group),
    items: KEYMAP_DEFINITIONS.filter(
      (definition) => definition.group === group,
    ),
  }));
}

export function advanceSequence(
  event: KeyboardEvent,
  binding: string,
  pendingRef: { current: number },
  timerRef: { current?: ReturnType<typeof setTimeout> },
  onMatch: () => void,
  consume: () => void,
  timeoutMs = 500,
): boolean {
  const tokens = binding
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return false;
  const token = sequenceTokenFromEvent(event);
  if (!token) return false;

  const reset = (): void => {
    pendingRef.current = 0;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = undefined;
  };

  if (pendingRef.current > 0) {
    if (token === tokens[pendingRef.current]) {
      consume();
      pendingRef.current += 1;
      if (pendingRef.current >= tokens.length) {
        reset();
        onMatch();
      } else {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(reset, timeoutMs);
      }
      return true;
    }
    reset();
  }

  if (token !== tokens[0]) return false;
  consume();
  if (tokens.length === 1) {
    onMatch();
    return true;
  }
  pendingRef.current = 1;
  if (timerRef.current) clearTimeout(timerRef.current);
  timerRef.current = setTimeout(reset, timeoutMs);
  return true;
}

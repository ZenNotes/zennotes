/**
 * Preference keys (matching the renderer's `Prefs` shape) persisted to the
 * portable config file. Keep this list in sync with `Prefs` in
 * `packages/app-core/src/store.ts`; new portable settings should be added
 * here AND given a TOML mapping in `apps/desktop/src/main/app-config.ts`.
 */
export const PORTABLE_PREF_KEYS = [
  // vim
  'vimMode',
  'vimInsertEscape',
  'vimYankToClipboard',
  'vimBlockImeInNormalMode',
  'vimWrappedLineMotions',
  'whichKeyHints',
  'whichKeyHintMode',
  'whichKeyHintTimeoutMs',
  // keymaps (overrides only)
  'keymapOverrides',
  'ignoredKeys',
  'externalApplicationSchemes',
  // search
  'vaultTextSearchBackend',
  'ripgrepBinaryPath',
  'fzfBinaryPath',
  // editor
  'livePreview',
  'showHeadingLevelLabels',
  'listIndentGuides',
  'renderTablesInLivePreview',
  'completedTaskStyle',
  'mathRenderer',
  'typstTagPreambles',
  'harperEnabled',
  'harperDialect',
  'looseMathDelimiters',
  'keepViewModeAcrossNotes',
  'keepPanelsAcrossNotes',
  'persistUndoHistory',
  'defaultPaneMode',
  'syncTitleHeadingOnRename',
  'markdownSnippets',
  'textReplacementsEnabled',
  'textReplacements',
  'autoPairs',
  'autoPairQuotesInProse',
  'hideBuiltinTemplates',
  'tabsEnabled',
  'wrapTabs',
  'editorFontSize',
  'mathFontScale',
  'editorLineHeight',
  'editorTabSize',
  'editorScrollOff',
  'timeFormat',
  'previewMaxWidth',
  'editorMaxWidth',
  'lineNumberMode',
  'lineNumberPosition',
  'viewSettingsScope',
  'wordWrap',
  'previewSmoothScroll',
  'pdfEmbedInEditMode',
  'pdfExportUseTheme',
  // appearance
  'themeId',
  'themeFamily',
  'themeMode',
  'enabledOverrides',
  'themeTweaks',
  'darkSidebar',
  'showWindowTitleBar',
  'showSidebarChevrons',
  'contentAlign',
  'unifiedSidebar',
  // typography
  'interfaceFont',
  'textFont',
  'monoFont',
  // features
  'workflowsEnabled',
  'hiddenWorkflowPresets',
  'atlasEnabled',
  // view
  'systemFolderLabels',
  'noteSortOrder',
  'assetSortOrder',
  'groupByKind',
  'nestedTags',
  'autoReveal',
  'quickNoteDateTitle',
  'quickNoteTitlePrefix',
  'autoCalendarPanel',
  'calendarWeekStart',
  'calendarShowWeekNumbers',
  'tasksViewMode',
  'showArchivedTasks',
  'kanbanGroupBy',
  'kanbanFolderRoot',
  'kanbanColumnTitles',
  'kanbanStatuses',
  // tasks
  'savedTaskFilters'
] as const

export type PortablePrefKey = (typeof PORTABLE_PREF_KEYS)[number]

/**
 * Transport shape for the portable config across the IPC boundary. Values are
 * `unknown` on purpose , the file is user-editable plain text, so the renderer
 * funnels everything through `normalizePrefs()` for validation rather than
 * trusting compile-time types here.
 */
export type AppConfigPortable = Partial<Record<PortablePrefKey, unknown>>

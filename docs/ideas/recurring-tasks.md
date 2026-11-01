# Recurring Tasks and Reminders

Tasks that come back on a schedule, and a nudge before one is due
([#1036](https://github.com/ZenNotes/zennotes/issues/1036), by @williamcheuk03).

> **Status (November 2026).** Slice 1 is built (recurrence for checkbox tasks
> on every app surface and MCP, desktop reminders), not yet released. Slices 2
> and 3 below are still design. Written from an inventory of the task system on
> `v2.81.0` and of Obsidian Tasks, TaskNotes and obsidian-reminder. Mockup:
> `recurring-tasks-mockup.html` beside this file (drawn before the build; see
> "Built differently" at the end).

## What exists today

- **Task line.** `- [ ]` with five states (` ` open, `/` in progress, `x` done,
  `>` forwarded, `-` cancelled) and four tokens: `due:YYYY-MM-DD`, `!high|med|low`,
  `@waiting`, `@key:value` fields (#354), plus `#tags`. Dates are date-only.
- **Four synced parsers.** `packages/shared-domain/src/tasks.ts` (normative), the
  MCP copy in `apps/desktop/src/mcp/vault-ops.ts`, `zn` in
  `zennotescli/internal/vault/tasks.go`, and `znserver/internal/vault/parse.go`.
  All four already read `@key:value`; the app and Go strip it from the display
  text, MCP and `zn` leave it in.
- **Daily notes.** `tasksDueOnNoteDate` gives a task its note's date; rollover
  carries open task blocks into today; `moveTaskToDate`; forwarding with its
  subtree (#611). `taskBlockEnd` is the one definition of a task's subtree.
- **File tasks** (TaskNotes style): `tags: [task]`, `status`, `due`, `scheduled`,
  `completedDate`, `priority` in frontmatter.
- **Every way a task gets checked off:** the store's `toggleTaskFromList` (Tasks
  list, Home, Calendar panel, Timeline, the task menu), `applyTaskMutation`
  `set-checked` (a Kanban drop into Done), editor `Mod+L`, the live-preview
  checkbox widget, Preview's checkbox click, the phone Calendar widget's
  precomputed `toggled` line, MCP `toggle_task`, `zn task toggle` and the TUI `x`.
  The Go server has no toggle route: clients write the note.
- **Recurrence:** none. **Notifications:** only the updater uses Electron's
  `Notification`. **Background:** Keep running in tray hides the window instead
  of closing it.

## Syntax

Two new `@key:value` fields. Riding the field grammar means none of the four
parsers changes to read or strip them, an Obsidian user sees plain text, and a
value is case-insensitive (parsers lower-case fields).

```
- [ ] Water the plants @repeat:weekly due:2026-11-01 @remind:9am
```

### `@repeat:<rule>`

| Rule | Next date |
| --- | --- |
| `daily`, `weekly`, `monthly`, `yearly` | one day, week, month or year on |
| `weekdays` | the next Monday to Friday |
| `2d`, `3w`, `6m`, `1y` | every N days, weeks, months, years |
| `mon`, `mon/thu` | the next of those weekdays |
| `after-3d` (any interval) | N after the day you finish it |

An unknown rule draws as a dim chip and the task checks off like any other.

### `@remind:<when>`

| When | Fires |
| --- | --- |
| `9am`, `2pm`, `930am`, `0930`, `1730` | at that time on the due date |
| `1d`, `2d` | N days before, at the default reminder time (09:00) |
| `1d-6pm` | N days before, at that time |

A reminder needs a due date, written or taken from the daily note. Without one
it is inert (dim chip). Times display in the app's 12h/24h format.

### Why not Obsidian Tasks' `🔁 every week`

Obsidian Tasks writes its dates as emoji too (`📅 2026-11-01`), and ZenNotes
reads none of them, so its rule alone would be half a format. A vault shared
both ways stays safe: Tasks ignores `@repeat:`, and ZenNotes ignores `🔁`.
Reading the emoji format is its own feature; if it lands, `🔁 every <rule>` maps
onto the same rule model.

## Checking off a recurring task

```diff
- - [ ] Water the plants @repeat:weekly due:2026-11-01 @remind:9am
+ - [ ] Water the plants @repeat:weekly due:2026-11-08 @remind:9am
+ - [x] Water the plants due:2026-11-01
```

1. **When.** On open (`[ ]` or `[/]`) to done, from any app surface, MCP, and
   `zn` once mirrored. Typing an `x` into the brackets by hand is a text edit,
   not a command, and does not repeat (Obsidian Tasks draws the same line).
2. **The next occurrence goes directly above** the finished line, with the same
   indent and list marker, a fresh `[ ]`, and the next date in `due:`. That is
   Obsidian Tasks' default order, and the open task stays where the cursor and
   the list cursor already are. Per-occurrence state does not carry over:
   `@waiting` and `@status:` drop, so the next one starts in the board's first
   column.
3. **Subtasks repeat too.** The task's subtree is copied under the new line
   with every checkbox reset to `[ ]`. The finished line keeps its subtree as
   the record of that week, ticks and all, and cancels (`[-]`) the subtasks
   left open, so only the fresh copies read as live work. Subtasks selected
   along with the task (`Vjj` then `Mod+L`) are written done instead.
4. **The finished line is a record.** It drops `@repeat` and `@remind`, the two
   tokens that only mean something on open work. Obsidian Tasks keeps the rule;
   we drop it so unchecking the record, or dragging a Done card back and forth,
   never spawns a second copy.
5. **The next date** counts from the due date (written, else the daily note's,
   else today) and is the first date of the rule after both the due date and
   today. A daily task finished five days late gets tomorrow, not five overdue
   copies. Obsidian Tasks does not skip; we do, on purpose. `after-` rules count
   from today.
6. **Month ends clamp.** `monthly` from Jan 31 gives Feb 28; the line then only
   knows the 28th. Documented; a `monthly-last` rule can come later.
7. **Daily notes.** The next occurrence stays in the same note with an explicit
   `due:`. Rollover then carries it like any open task. Writing it into the
   target day's note instead would create future daily notes nobody asked for.
8. **Skip this time** (task menu) writes the record as `[-]` cancelled and
   schedules the next one. **Cancel** on a recurring task ends the series.
9. **Undo.** One `Mod+Z` in the editor. In the Tasks views a toast reads
   "Next: Sun, Nov 8" with Undo, through the toast's existing action slot.
10. **File tasks (slice 2), TaskNotes compatible.** The note stays one file.
    ZenNotes reads TaskNotes' `recurrence:` RRULE (FREQ, INTERVAL, BYDAY,
    optional DTSTART) and `recurrence_anchor`. Finishing appends the date to
    `complete_instances`, advances `scheduled` and `due`, and leaves `status`
    open. Skip appends to `skipped_instances`. Setting a repeat on a file task
    writes `recurrence:`, never a ZenNotes-only key.

## Reminders on desktop

```
renderer: vaultTasks ─▶ computeTaskReminders() ─▶ zen.setTaskReminders(list)
main:     validate ─▶ userData/task-reminders.json ─▶ one timer ─▶ Notification
click:    focus window ─▶ IPC open-reminder ─▶ store.openTaskAt(task)
```

- **One pure function** in shared-domain, `computeTaskReminders(tasks, now,
  prefs)`, turns open tasks with `@remind:` into `{ key, fireAt, title, body,
  path }`. The renderer runs it on the task index it already keeps (debounced,
  next 7 days), so local and remote vaults behave the same.
- **Main schedules and fires.** `task-reminders.ts` validates the payload (at
  most 500 items, bounded strings, finite times, vault-relative paths), persists
  it, and arms one timer for the earliest unfired item, re-armed after each fire
  and capped at an hour so sleep and clock changes cannot strand it. It
  re-checks on `powerMonitor` resume and unlock. Notifications are retained
  until closed so their click handler survives garbage collection.
- **What shows.** Title: the task text. Body: "Due today · Home" (or "Due
  tomorrow"). Click: show and focus the window (out of the tray too) and open
  the task. More than three at once fold into one: "4 task reminders".
- **Fire once.** A ledger of fired keys (path, task text, fire time) stops a
  re-send or a relaunch from repeating a reminder; entries older than 7 days are
  pruned. Done, cancelled and forwarded tasks never fire.
- **Settings → Tasks**, one line each, all portable (`[view]` in config.toml,
  `task_reminders` and `task_reminder_time`): Task reminders (on), Reminder
  time (09:00), and in slice 2 Daily summary (off).

### While the app is closed

- **Quit:** nothing fires. Electron has no scheduled OS notification API, and a
  native one per platform is not worth it while the phones can do it properly.
- **On the next launch,** every reminder whose time fell between the last
  moment ZenNotes was watching and now, up to 24 hours back, fires once, folded
  into "3 reminders while ZenNotes was closed". Older ones drop: the task
  already shows as due or overdue. TaskNotes does the same 24-hour catch-up.
- **Window closed, Keep running in tray:** reminders fire on time.
- **Asleep:** on wake, anything missed (within 24 h) fires at once.

## Phones, web, server, CLI, MCP

| Surface | Recurrence | Reminders |
| --- | --- | --- |
| Desktop | slice 1 | slice 1 |
| Self-hosted web client | free with app-core (the client writes the note) | later: Notification API while a tab is open |
| iPhone and Android apps | free when they adopt the core; the Calendar widget gets a two-line `toggled` (next + record), or opens the app when the task has subtasks | slice 3: OS local notifications, which fire with the app closed (iOS caps pending ones at 64) |
| MCP `toggle_task` | imports the shared function | none |
| `zn` CLI + TUI | Go mirror of the completion edit, slice 2 | none |
| znserver | nothing: parsing already reads the fields, writes come from clients | none (an ICS feed with alarms is a later idea) |

The completion edit gets one table of cases (JSON) that the TypeScript and Go
tests both run, so the two implementations cannot drift.

## Keyboard

- **Tasks list, board, calendar (Vim on):** `r` Repeat…, `R` Remind…, also in
  the task menu (`m`, Shift+F10) with the keys as hints. Neither letter is bound
  on its own in those views today (the board's `zR` is a two-key sequence).
- **Vim off:** the same two entries in the task menu (Shift+F10, Context Menu
  key) and the command palette ("Task: Repeat…", "Task: Remind…").
- **Editor:** `:repeat weekly`, `:repeat off`, `:remind 9am`, `:remind off` act
  on the cursor's task line; typing `@repeat:` or `@remind:` offers the values.
- **Pickers:** Daily, Weekdays, Weekly, Monthly, Yearly, Custom…, Stop
  repeating; Morning of (09:00), Day before, Custom…, No reminder.

## Display

- **Editor (live preview):** the tokens stay as typed and get the chip styling
  `due:` already has, in their own colors (aqua for `@repeat:`, yellow for
  `@remind:`), so the source never hides behind a widget.
- **Tasks list and board:** one quiet `↻` chip beside the due date (the rule in
  its tooltip) and `⏰ 9:00` when a reminder is set. No new toolbar controls.
- **Kanban:** `repeat` and `remind` are not offered as group-by fields.

## Slices

1. **Recurrence for inline tasks + desktop reminders.** The shared rule parser,
   next-date math and completion edit (line + subtree) with tests; every app
   check-off path; Skip this time; MCP; chips, pickers, `r`/`R`, ex commands,
   completions; `@remind:` scheduling, notifications, catch-up, two Settings
   rows; help.ts + website docs.
2. **File tasks (TaskNotes recurrence and `reminders:`), the `zn` mirror,
   Daily summary.**
3. **Phones:** core adoption, widget toggle, local notifications.

## Open questions

1. `@repeat:` / `@remind:` fields (no parser changes) versus dedicated
   `repeat:` / `remind:` tokens like `due:` (four parser changes, but `remind:09:00`
   could carry a colon).
2. Drop `@repeat` from the finished line (proposed) or keep it like Obsidian Tasks.
3. Skip missed occurrences (proposed) or step one interval like Obsidian Tasks.
4. Is slice 1 the right first cut, or recurrence alone first?

## Built differently from the mockup

- The Tasks views mark a recurring task with small stroke icons (repeat arrows,
  a bell and the time), not the `↻` / `⏰` glyphs: the alarm clock drew as a
  red color emoji.
- Repeat… and Remind… are the app's prompt with preset suggestions, not a
  menu: the presets are one Enter away and any other rule types in place.
- From the Tasks views a new rule lands at the end of the line, like every
  other list edit (due, priority, `@status:`); `:repeat` in the editor
  replaces it where it stands.
- `x` in the Tasks list does not linger a recurring task's row: the row is the
  next occurrence by then, and a second `x` would check that one off. The
  toast's Undo is the way back.
- The record cancels the subtasks left open (Adib, 2026-11-01), so they no
  longer stand on the Tasks list beside the next occurrence's fresh copies.


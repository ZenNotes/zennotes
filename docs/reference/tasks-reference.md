# Tasks Reference

This document describes how ZenNotes detects, displays, and edits Markdown tasks.

It is a reference for the current task model, not a project-management methodology guide.

## Task syntax

ZenNotes reads Markdown task list items outside fenced code blocks.

Supported checkbox forms include unordered and ordered list items:

```md
- [ ] Write release notes
- [x] Publish the changelog
1. [ ] Review screenshots
```

Checked tasks use `[x]` or `[X]`. Unchecked tasks use `[ ]`.

## Inline task metadata

ZenNotes recognizes these inline tokens on a task line:

| Token | Meaning |
| --- | --- |
| `due:YYYY-MM-DD` | Due date in ISO format |
| `!high` | High priority |
| `!med` | Medium priority |
| `!low` | Low priority |
| `@waiting` | Waiting or blocked task |
| `#tag` | Task tag |

Priority aliases such as `!h`, `!m`, `!medium`, and `!l` are also recognized.
When ZenNotes edits priority from Kanban, it writes the canonical `!high`, `!med`, or `!low` token.

Example:

```md
- [ ] Refresh onboarding screenshots due:2026-04-30 !high @waiting #docs
```

Task display strips recognized metadata from the main task title while keeping tags and badges visible in task views.

## Note-level defaults

Tasks can inherit supported defaults from frontmatter:

```md
---
due: 2026-04-30
priority: high
---

- [ ] This task inherits the due date and priority
```

Inline task metadata wins over frontmatter defaults.

## Tasks views

The Tasks tab has three modes:

| Mode | Purpose |
| --- | --- |
| List | Scan and manage all vault tasks in a compact list |
| Calendar | Review scheduled tasks by due date |
| Kanban | Move tasks between task-state columns |

Clicking a task opens its source note at the exact task line and briefly highlights that line.
In the Tasks tab, `Space` or `x` toggles the focused task.

## Kanban grouping

Kanban can group tasks by status, priority, or folder.

### Status

Status columns are derived from checkbox state, due date, and `@waiting`.

| Default column | Contains |
| --- | --- |
| Today | Unchecked tasks with no due date, overdue tasks, and tasks due today |
| Upcoming | Unchecked future-due tasks |
| Waiting | Unchecked tasks with `@waiting` |
| Done | Checked tasks |

Waiting overrides due-date grouping. Done overrides every other status group.

Dragging between status columns updates the source task line:

| Drop target | Source-line effect |
| --- | --- |
| Today | Unchecks the task, removes `@waiting`, and sets `due:` to today |
| Upcoming | Unchecks the task, removes `@waiting`, and preserves a future due date or sets tomorrow |
| Waiting | Unchecks the task and adds `@waiting` |
| Done | Checks the task |

### Priority

Priority columns are `High`, `Medium`, `Low`, and `No priority`.

Dragging between priority columns changes the task priority token.

### Folder

Folder grouping is read-only. Moving a task between folders means moving its source note, which is done from the sidebar or file workflows rather than Kanban drag and drop.

## Kanban column titles

Kanban column titles are editable display labels.

To rename a column:

1. Click the column title or pencil icon.
2. Type the new title.
3. Press `Enter` or click away to save.

Press `Escape` to cancel the edit.

Clear the title and save to reset the column to its default label.

Column title overrides are app preferences. They do not change task grouping, due dates, priority, `@waiting`, or checkbox state.

For example, you can rename the status columns to labels such as `Backlog`, `Todo`, `In Progress`, and `Done`, but the underlying status behavior still follows the status rules above.

## Kanban drag behavior

Kanban drag and drop updates the board immediately, then writes the source note asynchronously.

While dragging, ZenNotes shows an insertion line at the exact position where the task will land. Same-column reordering changes the local Kanban order only; it does not rewrite task metadata.

## Notifications

The Tasks feature does not schedule task reminder notifications.

ZenNotes may still use native notifications for app-level events such as update availability in desktop builds.

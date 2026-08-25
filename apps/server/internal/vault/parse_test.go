package vault

import "testing"

func TestBodyHasLocalAssetDetectsOnlyLocalAssets(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{
			name: "plain wikilink",
			body: "# Plain\n\n[[Project Note]]\n",
			want: false,
		},
		{
			name: "relative image",
			body: "# Image\n\n![diagram](../attachements/diagram.png)\n",
			want: true,
		},
		{
			name: "embedded pdf",
			body: "# Embed\n\n![[brief.pdf]]\n",
			want: true,
		},
		{
			name: "remote image",
			body: "# Remote\n\n![diagram](https://example.com/diagram.png)\n",
			want: false,
		},
		{
			name: "code fenced local asset",
			body: "# Code\n\n```md\n![diagram](local.png)\n```\n",
			want: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := BodyHasLocalAsset(tc.body); got != tc.want {
				t.Fatalf("BodyHasLocalAsset() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestExtractorsStillIgnoreCodeAfterFastPathGuards(t *testing.T) {
	body := "# Real #tag\n\n```md\n#ignored [[Ignored]] ![[ignored.pdf]]\n```\n\n[[Target|Label]]"

	tags := ExtractTags(body)
	if len(tags) != 1 || tags[0] != "tag" {
		t.Fatalf("ExtractTags() = %#v, want [tag]", tags)
	}

	wikilinks := ExtractWikilinks(body)
	if len(wikilinks) != 1 || wikilinks[0] != "Target" {
		t.Fatalf("ExtractWikilinks() = %#v, want [Target]", wikilinks)
	}
}

// #293: a fenced code block nested under a list item (indented) is still code —
// its `#include` line must not be indexed as a tag.
func TestExtractTagsIgnoresIndentedFence(t *testing.T) {
	body := "- bullet\n\n  ```c\n  #include <stdio.h>\n  ```\n\n#kept"

	tags := ExtractTags(body)
	if len(tags) != 1 || tags[0] != "kept" {
		t.Fatalf("ExtractTags() = %#v, want [kept]", tags)
	}
}

func TestExtractTagsIncludesFrontmatterTags(t *testing.T) {
	body := "---\ntags: [frontmatter, \"#quoted\", project/nested]\ntitle: #ignored\n---\n\n#inline"

	tags := ExtractTags(body)
	want := []string{"frontmatter", "quoted", "project/nested", "inline"}
	if len(tags) != len(want) {
		t.Fatalf("ExtractTags() = %#v, want %#v", tags, want)
	}
	for i := range want {
		if tags[i] != want[i] {
			t.Fatalf("ExtractTags() = %#v, want %#v", tags, want)
		}
	}
}

func TestExtractTagsSplitsBareFrontmatterScalar(t *testing.T) {
	tags := ExtractTags("---\ntags: daily, work\n---\nbody")
	if len(tags) != 2 || tags[0] != "daily" || tags[1] != "work" {
		t.Fatalf("ExtractTags() = %#v, want [daily work]", tags)
	}
}

func TestExtractTagsIncludesFrontmatterTagList(t *testing.T) {
	body := "---\ntags:\n  - daily\n  - \"#log\"\n---\n\nBody"

	tags := ExtractTags(body)
	if len(tags) != 2 || tags[0] != "daily" || tags[1] != "log" {
		t.Fatalf("ExtractTags() = %#v, want [daily log]", tags)
	}
}

// #205: tags in non-Latin scripts (Cyrillic, CJK, …) must be recognized.
func TestExtractTagsUnicode(t *testing.T) {
	body := "Заметки: #тест #ошибка/баг и 笔记 #标签 plus #ascii-1 done"
	got := ExtractTags(body)
	want := map[string]bool{"тест": true, "ошибка/баг": true, "标签": true, "ascii-1": true}
	if len(got) != len(want) {
		t.Fatalf("ExtractTags() = %#v, want keys %#v", got, want)
	}
	for _, tag := range got {
		if !want[tag] {
			t.Fatalf("unexpected tag %q in %#v", tag, got)
		}
	}
}

// #450: `[-]` cancelled tasks must be parsed (not dropped) and flagged cancelled.
func TestParseTasksRecognizesCancelled(t *testing.T) {
	body := "- [ ] open\n- [x] done\n- [>] gone\n- [-] scrapped\n"
	tasks := ParseTasks("inbox/t.md", "t", FolderInbox, body)
	if len(tasks) != 4 {
		t.Fatalf("expected 4 tasks (none dropped), got %d", len(tasks))
	}
	byContent := map[string]Task{}
	for _, tk := range tasks {
		byContent[tk.Content] = tk
	}
	if c, ok := byContent["scrapped"]; !ok {
		t.Fatal("cancelled task line was dropped")
	} else if !c.Cancelled || c.Checked {
		t.Errorf("scrapped: Cancelled=%v Checked=%v, want Cancelled=true Checked=false", c.Cancelled, c.Checked)
	}
	if byContent["open"].Cancelled || byContent["done"].Cancelled {
		t.Error("open/done tasks should not be cancelled")
	}
}

func TestParseTaskFileCancelledStatus(t *testing.T) {
	body := "---\ntags: [task]\ntitle: Rewrite\nstatus: cancelled\n---\n\nAbandoned.\n"
	task, ok := parseTaskFile("inbox/x.md", "x", FolderInbox, body)
	if !ok {
		t.Fatal("expected a file task")
	}
	if !task.Cancelled || task.Checked {
		t.Errorf("Cancelled=%v Checked=%v, want Cancelled=true Checked=false", task.Cancelled, task.Checked)
	}
}

// #512: `[/]` in-progress tasks parse as open work, flagged InProgress. The
// server mirrors shared-domain here, so a web client sees the same states the
// desktop app does.
func TestParseTasksRecognizesInProgress(t *testing.T) {
	body := "- [ ] open\n- [/] started\n- [x] done\n- [-] scrapped\n1. [/] numbered\n"
	tasks := ParseTasks("inbox/t.md", "t", FolderInbox, body)
	if len(tasks) != 5 {
		t.Fatalf("expected 5 tasks (none dropped), got %d", len(tasks))
	}
	byContent := map[string]Task{}
	for _, tk := range tasks {
		byContent[tk.Content] = tk
	}
	for _, name := range []string{"started", "numbered"} {
		tk, ok := byContent[name]
		if !ok {
			t.Fatalf("in-progress task %q was dropped", name)
		}
		if !tk.InProgress {
			t.Errorf("%s: InProgress=false, want true", name)
		}
		if tk.Checked || tk.Cancelled {
			t.Errorf("%s: Checked=%v Cancelled=%v, want both false", name, tk.Checked, tk.Cancelled)
		}
	}
	if byContent["open"].InProgress || byContent["done"].InProgress || byContent["scrapped"].InProgress {
		t.Error("open/done/cancelled tasks should not be in progress")
	}
}

func TestParseTaskFileInProgressStatus(t *testing.T) {
	for _, status := range []string{"in-progress", "doing", "started", "wip"} {
		body := "---\ntags: [task]\ntitle: Rewrite\nstatus: " + status + "\n---\n\nHalf done.\n"
		task, ok := parseTaskFile("inbox/x.md", "x", FolderInbox, body)
		if !ok {
			t.Fatalf("%s: expected a file task", status)
		}
		if !task.InProgress {
			t.Errorf("%s: InProgress=false, want true", status)
		}
		if task.Checked || task.Cancelled {
			t.Errorf("%s: Checked=%v Cancelled=%v, want both false", status, task.Checked, task.Cancelled)
		}
	}
}

// #643: a server-backed board must receive the same custom-status fields as
// the desktop parser. Otherwise the optimistic move sticks until the watcher
// rescan replaces it with a task that appears to have no status.
func TestParseTaskFileIncludesCustomStatusField(t *testing.T) {
	body := "---\ntags: [task]\ntitle: Rewrite\nstatus: A\n---\n\nDetails.\n"
	task, ok := parseTaskFile("inbox/x.md", "x", FolderInbox, body)
	if !ok {
		t.Fatal("expected a file task")
	}
	if task.Status != "a" {
		t.Errorf("Status=%q, want %q", task.Status, "a")
	}
	if got := task.Fields["status"]; got != "a" {
		t.Errorf("Fields[status]=%q, want %q", got, "a")
	}
}

// #672: a file task whose frontmatter says nothing is effectively open but
// has no custom status. Reporting one put it in an "Open" column with a
// phantom @status:open chip, and a drop into "No status" (which clears the
// key) was undone by the next rescan, so the card bounced between the two.
func TestParseTaskFileWithoutStatusHasNoCustomStatusField(t *testing.T) {
	body := "---\ntitle: Ship it\ntags: [ task ]\ndue: 2026-08-24\n---\n"
	task, ok := parseTaskFile("inbox/x.md", "x", FolderInbox, body)
	if !ok {
		t.Fatal("expected a file task")
	}
	if task.Status != "open" || task.Checked || task.Cancelled {
		t.Errorf("Status=%q Checked=%v Cancelled=%v, want open/false/false", task.Status, task.Checked, task.Cancelled)
	}
	if _, has := task.Fields["status"]; has {
		t.Errorf("Fields=%#v, want no status key", task.Fields)
	}
	if task.Fields == nil {
		t.Error("Fields must be an empty map, not nil, so the JSON stays {}")
	}
}

func TestParseTasksIncludesCustomFields(t *testing.T) {
	body := "---\nstatus: Backlog\n---\n- [ ] inherits\n- [ ] override @status:Review @sprint:24 @area:Backend\n"
	tasks := ParseTasks("inbox/t.md", "t", FolderInbox, body)
	if len(tasks) != 2 {
		t.Fatalf("expected 2 tasks, got %d", len(tasks))
	}
	if tasks[0].Status != "backlog" || tasks[0].Fields["status"] != "backlog" {
		t.Errorf("inherited task fields=%#v status=%q, want status=backlog", tasks[0].Fields, tasks[0].Status)
	}
	want := map[string]string{"status": "review", "sprint": "24", "area": "backend"}
	for key, value := range want {
		if got := tasks[1].Fields[key]; got != value {
			t.Errorf("Fields[%s]=%q, want %q", key, got, value)
		}
	}
	if tasks[1].Status != "review" {
		t.Errorf("Status=%q, want review", tasks[1].Status)
	}
	if tasks[1].Content != "override" {
		t.Errorf("Content=%q, want custom-field tokens stripped", tasks[1].Content)
	}
}

// #458: the frontmatter `tasks:` key turns a note's checkboxes back into plain
// checkboxes. The server mirrors noteTasksMode in shared-domain; the accepted
// values must stay byte-identical across runtimes.
func TestParseTasksFrontmatterTasksOptOut(t *testing.T) {
	checklist := "- [ ] Dune\n- [x] Hyperion\n- [ ] Blindsight due:2026-09-01\n"
	for _, val := range []string{"false", "off", "False", "OFF", "\"false\""} {
		body := "---\ntasks: " + val + "\n---\n" + checklist
		if tasks := ParseTasks("inbox/t.md", "t", FolderInbox, body); len(tasks) != 0 {
			t.Errorf("tasks: %s: expected no tasks, got %d", val, len(tasks))
		}
	}
	// Unrecognized values fall back to the pre-#458 behavior.
	for _, val := range []string{"true", "yes", "everything"} {
		body := "---\ntasks: " + val + "\n---\n" + checklist
		if tasks := ParseTasks("inbox/t.md", "t", FolderInbox, body); len(tasks) != 3 {
			t.Errorf("tasks: %s: expected 3 tasks, got %d", val, len(tasks))
		}
	}
}

func TestParseTasksFrontmatterTasksFalseWinsOverTaskTag(t *testing.T) {
	body := "---\ntags: [task]\ntasks: false\n---\n\n- [ ] hidden\n"
	if tasks := ParseTasks("inbox/t.md", "t", FolderInbox, body); len(tasks) != 0 {
		t.Fatalf("expected tasks: false to suppress the file task too, got %d tasks", len(tasks))
	}
}

func TestParseTasksFrontmatterTasksNoteKeepsFileTaskOnly(t *testing.T) {
	body := "---\ntags: [task]\ntasks: note\nstatus: in-progress\ndue: 2026-09-01\n---\n\n- [ ] research\n- [x] outline\n"
	tasks := ParseTasks("inbox/t.md", "t", FolderInbox, body)
	if len(tasks) != 1 {
		t.Fatalf("expected exactly the file task, got %d tasks", len(tasks))
	}
	tk := tasks[0]
	if tk.Kind != "file" || tk.ID != "inbox/t.md#task" {
		t.Errorf("Kind=%q ID=%q, want file task", tk.Kind, tk.ID)
	}
	if !tk.InProgress || tk.Due != "2026-09-01" {
		t.Errorf("InProgress=%v Due=%q, want frontmatter metadata intact", tk.InProgress, tk.Due)
	}
	// On a note without the task tag, `tasks: note` simply silences checkboxes.
	plain := "---\ntasks: note\n---\n\n- [ ] a\n- [ ] b\n"
	if tasks := ParseTasks("inbox/p.md", "p", FolderInbox, plain); len(tasks) != 0 {
		t.Errorf("expected no tasks for tasks: note without a task tag, got %d", len(tasks))
	}
}

func TestParseTasksWithIncludeExcluded(t *testing.T) {
	body := "---\ntags: [task]\ntasks: false\n---\n\n- [ ] hidden\n- [ ] also hidden\n"
	tasks := ParseTasksWith("inbox/t.md", "t", FolderInbox, body, ParseTasksOptions{IncludeExcluded: true})
	if len(tasks) != 3 {
		t.Fatalf("expected file task + 2 inline with IncludeExcluded, got %d", len(tasks))
	}
	if tasks[0].ID != "inbox/t.md#task" {
		t.Errorf("first task ID=%q, want the file task", tasks[0].ID)
	}
	// Index counting is untouched by the gate, so ids stay stable.
	if tasks[1].ID != "inbox/t.md#0" || tasks[2].ID != "inbox/t.md#1" {
		t.Errorf("inline ids %q, %q, want #0 and #1", tasks[1].ID, tasks[2].ID)
	}
}

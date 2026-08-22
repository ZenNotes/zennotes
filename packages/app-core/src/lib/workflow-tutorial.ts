// The guided Workflows tutorial: real material, real actions, full cleanup.
//
// Workflows are learned by running one, so the tutorial does not simulate
// anything: it seeds a small practice library into the CURRENT vault, walks
// the user through the actual view (canvas, text, inspector, activation, the
// dry-run confirmation, apply, undo), and then removes every trace of itself.
//
// Two rules make that safe:
//
//   1. Everything the tutorial creates lives under ONE folder
//      (`inbox/Workflow tutorial`) plus one workflow file, and the practice
//      workflow reads and writes ONLY inside that folder. The user's own notes
//      are unreachable by construction, not by care.
//   2. Cleanup is a bulk delete of that namespace (folder, workflow file, run
//      ledgers), so it cannot miss anything a run created inside it, and
//      seeding starts with a cleanup so a tutorial abandoned by a crash never
//      leaves two copies behind.
import type { WorkflowFile } from '@bridge-contract/workflows'

/** Subpath under the Inbox folder that owns every practice note. */
export const TUTORIAL_FOLDER_SUBPATH = 'Workflow tutorial'

/**
 * Where the practice folder actually lives, vault-relative.
 *
 * NOT a constant, and never `inbox/${subpath}`. The folder API resolves 'inbox'
 * through the vault's settings, so on a `primaryNotesLocation: 'root'` vault
 * the practice folder is `Workflow tutorial` at the root, and on a vault whose
 * Inbox is remapped it is `<mapped dir>/Workflow tutorial`. Seeding used a
 * literal path while cleanup used the resolved one, which left the practice
 * notes behind on every vault that is not laid out the default way (#525).
 *
 * Callers pass the result of `vaultRelativeFolderPath('inbox',
 * TUTORIAL_FOLDER_SUBPATH, vaultSettings)`. This module stays store-free so it
 * still tests under node.
 */
export type TutorialFolderPath = string

/** Slug (and therefore workflow id) of the practice workflow. */
export const TUTORIAL_WORKFLOW_SLUG = 'tutorial-reading-list'

/** The practice notes: enough shape for the pipeline to have something to say.
 *  Ratings straddle the `>= 4` threshold so the "edit a step" chapter has a
 *  visible effect (lowering it to 3 pulls one more note onto the wire). */
export function tutorialNotes(
  folderPath: TutorialFolderPath
): ReadonlyArray<{ path: string; body: string }> {
  return [
    {
      path: `${folderPath}/Dune.md`,
      body: '---\nrating: 5\n---\n# Dune\n\n#tutorial-book\n\nSlow start, then impossible to put down.\n'
    },
    {
      path: `${folderPath}/Snow Crash.md`,
      body: '---\nrating: 4\n---\n# Snow Crash\n\n#tutorial-book\n\nThe first fifty pages alone earn the rating.\n'
    },
    {
      path: `${folderPath}/Sapiens.md`,
      body: '---\nrating: 3\n---\n# Sapiens\n\n#tutorial-book\n\nGood chapters, uneven middle.\n'
    },
    {
      path: `${folderPath}/Reading list.md`,
      body: '# Reading list\n\nThe tutorial workflow writes its Favorites section into this note.\n'
    }
  ]
}

/** The practice workflow. A draft on purpose: activating it is a chapter.
 *  Its `folder` source has to name the same resolved path the notes were
 *  written to, or the wire counts the user is told to expect come out zero. */
export function tutorialWorkflowRaw(folderPath: TutorialFolderPath): string {
  return `---
name: Tutorial reading list
description: The practice workflow the guided tutorial walks through
status: draft
trigger: manual
---

# The tutorial's practice workflow. It reads ONLY the notes inside
# "${folderPath}", so nothing else in your vault is ever touched.
books = folder "${folderPath}" | tagged #tutorial-book
good  = books | where rating >= 4

good | render list | write-section "${folderPath}/Reading list.md" "Favorites"
good | add-tag #favorite
`
}

/* -------------------------------------------------------------------------- */
/*  The chapters                                                              */
/* -------------------------------------------------------------------------- */

/** A view-observable condition. Every todo names one, so every todo checks
 *  itself off the moment the user actually does it; anything that cannot be
 *  observed is intro prose, not a todo. */
export type TutorialSignal =
  | 'select-tutorial'
  | 'node-inspected'
  | 'text-mode'
  | 'canvas-mode'
  | 'where-inspected'
  | 'threshold-eased'
  | 'workflow-active'
  | 'run-applied'
  | 'run-undone'
  | 'palette-opened'

/** One thing to actually do, and how the view notices it happened. Tasks are
 *  detected IN ORDER: a later todo arms only after the earlier ones are done,
 *  which is what lets "come back to the canvas" mean "after you went to the
 *  text" rather than "you are already there". */
export interface TutorialTask {
  text: string
  doneWhen: TutorialSignal
}

export interface TutorialStep {
  title: string
  /** One short orienting paragraph. The doing happens in `tasks`. */
  intro: string
  /** Empty only on the closing chapter, whose one action is Finish itself. */
  tasks: TutorialTask[]
}

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    title: 'Welcome',
    intro:
      `A workflow is a small pipeline you write once and run over your notes: find some, keep the right ones, do something with them. The tutorial just seeded a practice folder, "${TUTORIAL_FOLDER_SUBPATH}", with three rated book notes and a reading list; everything here stays inside it. The left pane lists this vault's workflows, each a plain .md file.`,
    tasks: [
      {
        text: 'Select "Tutorial reading list" in the list (click it, or j / k and Enter with Vim on).',
        doneWhen: 'select-tutorial'
      }
    ]
  },
  {
    title: 'The canvas',
    intro:
      'This picture IS the file: sources on the left, steps in the middle, sinks on the right. Wires carry sets of notes with live counts: `books` holds the three practice notes, `good` the two rated 4 or better.',
    tasks: [
      {
        text: 'Click any step and read its settings in the inspector on the right.',
        doneWhen: 'node-inspected'
      }
    ]
  },
  {
    title: 'Text is the truth',
    intro:
      'The canvas and the text are two views of one file; neither is an export of the other.',
    tasks: [
      {
        text: 'Press e (or "Edit as text" in the header) to see the same workflow as text.',
        doneWhen: 'text-mode'
      },
      { text: 'Come back to the canvas (Escape or the same button).', doneWhen: 'canvas-mode' }
    ]
  },
  {
    title: 'Edit a step',
    intro:
      'Steps are edited in the inspector, edits save on their own, and the wire counts answer immediately.',
    tasks: [
      { text: 'Click the `where rating >= 4` step.', doneWhen: 'where-inspected' },
      {
        text: 'Change the 4 to a 3 and watch `good` go from 2 to 3: Sapiens just made the cut.',
        doneWhen: 'threshold-eased'
      }
    ]
  },
  {
    title: 'Activate it',
    intro:
      'New workflows arrive as drafts, and a draft can never run: reading something is not agreeing to let it loose on your notes.',
    tasks: [
      {
        text: 'Press the Draft badge in the header and confirm. The confirmation lists what kinds of changes this workflow can make.',
        doneWhen: 'workflow-active'
      }
    ]
  },
  {
    title: 'Run it',
    intro:
      'Nothing happens blind: a dry run lists every change first, grouped and counted, and nothing touches disk until you apply.',
    tasks: [
      {
        text: 'Press R (or the Run button), read the dry-run list, and apply it. The receipt arrives as a toast.',
        doneWhen: 'run-applied'
      }
    ]
  },
  {
    title: 'Take it back',
    intro:
      'Every run is journalled, so Undo restores each file it wrote byte for byte. Curious? "Reading list" in the practice folder just gained a Favorites section, and undoing takes it back out.',
    tasks: [{ text: 'Press Undo on the receipt toast.', doneWhen: 'run-undone' }]
  },
  {
    title: 'Run from anywhere',
    intro:
      'Once a workflow is active the view is optional: "Run Workflow…" opens a browsable picker, Space a opens this view from anywhere with Vim on, and pressing x in the recipe gallery (the New workflow button) hides recipes you will never use.',
    tasks: [
      {
        text: 'Open the command palette and spot "Run: Tutorial reading list". (No need to run it.)',
        doneWhen: 'palette-opened'
      }
    ]
  },
  {
    title: 'Done',
    intro:
      'That is the whole loop: a file, a picture of it, a dry run, an apply, an undo. Press Finish to remove the practice folder, the tutorial workflow, and its run history: your vault ends exactly as it started.',
    tasks: []
  }
]

/* -------------------------------------------------------------------------- */
/*  Seeding and cleanup                                                       */
/* -------------------------------------------------------------------------- */

/** The slice of the bridge the tutorial needs, injectable so tests can run it
 *  against a fake. `deleteWorkflowRuns` stays optional for older or minimal
 *  injected bridges; current desktop and web hosts both provide it. */
export interface TutorialBridge {
  writeNote(relPath: string, body: string): Promise<unknown>
  createFolder(folder: 'inbox', subpath: string): Promise<void>
  deleteFolder(folder: 'inbox', subpath: string): Promise<void>
  listWorkflows(): Promise<WorkflowFile[]>
  writeWorkflow(input: { slug: string; raw: string }): Promise<WorkflowFile>
  deleteWorkflow(sourcePath: string): Promise<void>
  deleteWorkflowRuns?(workflowId: string): Promise<number>
}

/**
 * Remove every trace of the tutorial. Safe to call when nothing is seeded
 * (cleanup of a clean vault is a no-op), which is what lets `seed` lead with
 * it and a crashed tutorial heal on the next start.
 */
export async function cleanupWorkflowTutorial(bridge: TutorialBridge): Promise<void> {
  const files = await bridge.listWorkflows().catch(() => [] as WorkflowFile[])
  const tutorial = files.find((file) => file.id === TUTORIAL_WORKFLOW_SLUG)
  if (tutorial) await bridge.deleteWorkflow(tutorial.sourcePath).catch(() => {})
  if (typeof bridge.deleteWorkflowRuns === 'function') {
    await bridge.deleteWorkflowRuns(TUTORIAL_WORKFLOW_SLUG).catch(() => {})
  }
  // Recursive: takes the seeded notes AND anything a practice run created.
  await bridge.deleteFolder('inbox', TUTORIAL_FOLDER_SUBPATH).catch(() => {})
}

/**
 * Seed the practice material, from a clean slate.
 *
 * `folderPath` must be where `createFolder('inbox', TUTORIAL_FOLDER_SUBPATH)`
 * actually lands, since cleanup deletes through that same folder API. Passing a
 * literal `inbox/...` on a root-mode or remapped vault writes the notes
 * somewhere cleanup will never look (#525).
 */
export async function seedWorkflowTutorial(
  bridge: TutorialBridge,
  folderPath: TutorialFolderPath
): Promise<void> {
  await cleanupWorkflowTutorial(bridge)
  await bridge.createFolder('inbox', TUTORIAL_FOLDER_SUBPATH)
  for (const note of tutorialNotes(folderPath)) {
    await bridge.writeNote(note.path, note.body)
  }
  await bridge.writeWorkflow({
    slug: TUTORIAL_WORKFLOW_SLUG,
    raw: tutorialWorkflowRaw(folderPath)
  })
}

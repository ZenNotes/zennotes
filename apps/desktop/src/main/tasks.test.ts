import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAllTasks, scanTasksForPath } from './tasks'
import { getVaultSettings, setVaultSettings } from './vault'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A flat (root-primary) vault with a template folder of placeholders and an
 *  ordinary note holding real work. */
async function seedVault(templates: { folder?: string } | undefined): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zennotes-template-folder-tasks-'))
  tempDirs.push(root)
  await mkdir(path.join(root, 'Templates', 'Work'), { recursive: true })
  await mkdir(path.join(root, 'Notes'), { recursive: true })
  await writeFile(path.join(root, 'Templates', 'Meeting.md'), '# {{title}}\n\n- [ ] agenda item\n')
  await writeFile(path.join(root, 'Templates', 'Work', 'Retro.md'), '- [ ] action item\n')
  await writeFile(path.join(root, 'Notes', 'Plan.md'), '# Plan\n\n- [ ] real work\n')
  const settings = await getVaultSettings(root)
  await setVaultSettings(root, { ...settings, primaryNotesLocation: 'root', templates })
  return root
}

const contents = (tasks: { content: string }[]): string[] => tasks.map((t) => t.content).sort()

// #1024: a template's `- [ ]` lines are placeholders for the note it will
// make, so the template folder never feeds Tasks.
describe('tasks and the template folder (#1024)', () => {
  it('leaves every note in the template folder out of the scan', async () => {
    const root = await seedVault({ folder: 'Templates' })
    expect(contents(await scanAllTasks(root))).toEqual(['real work'])
  })

  it('returns nothing for a single template note, so an edit never brings it back', async () => {
    const root = await seedVault({ folder: 'Templates' })
    expect(await scanTasksForPath(root, 'Templates/Meeting.md')).toEqual([])
    expect(contents(await scanTasksForPath(root, 'Notes/Plan.md'))).toEqual(['real work'])
  })

  it('counts those notes again once the setting is cleared', async () => {
    const root = await seedVault(undefined)
    expect(contents(await scanAllTasks(root))).toEqual(['action item', 'agenda item', 'real work'])
  })
})

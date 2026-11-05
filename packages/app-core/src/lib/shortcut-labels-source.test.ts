import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (name: string): string =>
  readFileSync(new URL(name.endsWith('.ts') ? `./${name}` : `../components/${name}.tsx`, import.meta.url), 'utf8')

describe('what a component shows', () => {
  it.each(['EditorPane', 'Sidebar', 'HomeView', 'CommentsPanel', 'OnboardingWizard', 'diagram-renderers.ts'])(
    '%s names no Mac key of its own',
    (name) => {
      const shown = read(name)
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .map((line) => line.replace(/\s\/\/ .*$/, ''))
        .join('\n')
      expect(shown).not.toMatch(/⌘/)
    }
  )
})

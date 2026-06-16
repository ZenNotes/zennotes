// Built-in note templates shipped as code constants (no IPC, no disk). The
// renderer imports these directly so they work on every platform — desktop,
// web, and remote vaults alike. Custom user templates are loaded separately
// from `.zennotes/templates/`. See `@shared/template-files` for parsing.
import type { NoteTemplate } from '@zennotes/bridge-contract/templates'

type BuiltinSpec = Omit<NoteTemplate, 'builtin'>

function builtin(spec: BuiltinSpec): NoteTemplate {
  return { ...spec, builtin: true }
}

export const BUILTIN_TEMPLATES: NoteTemplate[] = [
  // ---------------------------------------------------------------- Engineering
  builtin({
    id: 'builtin.adr',
    name: 'ADR',
    description: 'Architecture Decision Record',
    category: 'Engineering',
    body: `# {{title}}

- **Status:** Proposed
- **Date:** {{date}}
- **Deciders:**

## Context

{{cursor}}

## Decision

## Consequences

### Positive

### Negative

## Related

`
  }),
  builtin({
    id: 'builtin.rfc',
    name: 'RFC / Design Doc',
    description: 'Proposal with motivation, design, and alternatives',
    category: 'Engineering',
    body: `# {{title}}

- **Author:**
- **Status:** Draft
- **Date:** {{date}}

## Summary

{{cursor}}

## Motivation

## Proposal

## Alternatives considered

## Rollout & risks

## Related

`
  }),
  builtin({
    id: 'builtin.bug',
    name: 'Bug Report',
    description: 'Reproducible bug with expected vs actual behavior',
    category: 'Engineering',
    body: `# {{title}}

- **Date:** {{date}}
- **Severity:**
- **Environment:**

## Steps to reproduce

1. {{cursor}}

## Expected

## Actual

## Notes

`
  }),
  builtin({
    id: 'builtin.postmortem',
    name: 'Postmortem',
    description: 'Incident review: timeline, root cause, action items',
    category: 'Engineering',
    body: `# {{title}}

- **Date:** {{date}}
- **Authors:**
- **Impact:**

## Summary

{{cursor}}

## Timeline

## Root cause

## Resolution

## Action items

- [ ]

## Related

`
  }),
  builtin({
    id: 'builtin.meeting',
    name: 'Meeting Notes',
    description: 'Agenda, notes, decisions, and action items',
    category: 'Engineering',
    titleTemplate: 'Meeting — {{date:YYYY-MM-DD}}',
    body: `# {{title}}

- **Date:** {{date}}
- **Attendees:**

## Agenda

- {{cursor}}

## Notes

## Decisions

## Action items

- [ ]

`
  }),
  builtin({
    id: 'builtin.oneonone',
    name: '1:1',
    description: 'One-on-one: wins, blockers, growth, follow-ups',
    category: 'Engineering',
    titleTemplate: '1-1 — {{date:YYYY-MM-DD}}',
    body: `# {{title}}

- **Date:** {{date}}

## Wins

{{cursor}}

## Challenges & blockers

## Growth & feedback

## Follow-ups

- [ ]

`
  }),
  // ------------------------------------------------------------------- Personal
  builtin({
    id: 'builtin.reading',
    name: 'Reading Notes',
    description: 'Notes on a book or article: ideas, quotes, takeaways',
    category: 'Personal',
    body: `# {{title}}

- **Author:**
- **Started:** {{date}}
- **Status:** Reading

## Key ideas

- {{cursor}}

## Quotes

>

## Takeaways

## Related

`
  }),
  builtin({
    id: 'builtin.journal',
    name: 'Journal',
    description: 'A free-form, first-person dated entry',
    category: 'Personal',
    titleTemplate: '{{date:YYYY-MM-DD}}',
    body: `# {{date:dddd, MMMM D, YYYY}}

{{cursor}}

`
  }),
  builtin({
    id: 'builtin.kickoff',
    name: 'Project Kickoff',
    description: 'Goals, scope, milestones, and stakeholders',
    category: 'Personal',
    body: `# {{title}}

- **Date:** {{date}}
- **Owner:**

## Goals

- {{cursor}}

## Scope

### In scope

### Out of scope

## Milestones

## Stakeholders

## Risks

## Related

`
  }),
  builtin({
    id: 'builtin.todo',
    name: 'To-do',
    description: 'A simple checklist scaffold',
    category: 'Personal',
    body: `# {{title}}

- [ ] {{cursor}}
- [ ]
- [ ]

`
  })
]

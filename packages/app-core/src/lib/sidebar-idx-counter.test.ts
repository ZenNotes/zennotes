// @vitest-environment jsdom

import { act, createElement, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  useStableSidebarIdxBase,
  type SidebarIdxCounter,
  type SidebarIdxPass
} from './sidebar-idx-counter'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The sidebar in miniature: a parent that restarts the counter on every render
// and numbers one row of its own, then tree components that number theirs from
// the shared counter and can re-render without the parent.
describe('sidebar row numbering across lone re-renders', () => {
  let host: HTMLDivElement
  let root: Root
  let counter: SidebarIdxCounter
  const triggers: Record<string, () => void> = {}

  const row = (idx: number, name: string): ReactElement =>
    createElement('span', { key: name, 'data-idx': idx, 'data-name': name })

  // Like FolderTreeContents, a component builds its nested tree components
  // while it renders, so they re-render whenever it does.
  function Leafy({ name, guarded, nested, pass }: {
    name: string
    guarded: boolean
    nested?: string
    pass: SidebarIdxPass
  }): ReactElement {
    const [, setTick] = useState(0)
    // `guarded` is fixed for the life of a mounted tree, so hook order holds.
    const childPass = guarded ? useStableSidebarIdxBase(counter, pass) : {}
    triggers[name] = () => setTick((tick) => tick + 1)
    const first = counter.value++
    const second = counter.value++
    return createElement(
      'div',
      null,
      row(first, `${name}-1`),
      row(second, `${name}-2`),
      nested
        ? createElement(Leafy, { key: nested, name: nested, guarded, pass: childPass })
        : null
    )
  }

  /** What Sidebar's body does to the counter before any child renders. */
  const runParentBody = (extraRow: boolean): ReactElement[] => {
    counter.value = 0
    const rows = [row(counter.value++, 'header')]
    if (extraRow) rows.push(row(counter.value++, 'extra'))
    return rows
  }

  function Parent({ guarded, extraRow }: { guarded: boolean; extraRow: boolean }): ReactElement {
    const rows = runParentBody(extraRow)
    const pass: SidebarIdxPass = {}
    return createElement(
      'div',
      null,
      ...rows,
      createElement(Leafy, { key: 'outer', name: 'outer', guarded, nested: 'inner', pass }),
      createElement(Leafy, { key: 'tail', name: 'tail', guarded, pass })
    )
  }

  const numbering = (): Record<string, number> =>
    Object.fromEntries(
      [...host.querySelectorAll<HTMLElement>('[data-idx]')].map((el) => [
        el.dataset.name as string,
        Number(el.dataset.idx)
      ])
    )

  const render = (props: { guarded: boolean; extraRow?: boolean }): void => {
    act(() => root.render(createElement(Parent, { extraRow: false, ...props })))
  }

  beforeEach(() => {
    counter = { value: 0 }
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const sequential = {
    header: 0,
    'outer-1': 1,
    'outer-2': 2,
    'inner-1': 3,
    'inner-2': 4,
    'tail-1': 5,
    'tail-2': 6
  }

  it('models the bug: without the guard a lone re-render continues from the end of the last pass', () => {
    render({ guarded: false })
    expect(numbering()).toEqual(sequential)

    act(() => triggers.outer())

    // The whole subtree jumped by the sidebar's row count, so a stored cursor
    // of 1 now points at nothing.
    expect(numbering()['outer-1']).toBe(7)
    expect(numbering()['inner-1']).toBe(9)
  })

  it('keeps every row number when a tree component re-renders alone', () => {
    render({ guarded: true })
    expect(numbering()).toEqual(sequential)

    act(() => triggers.outer())
    expect(numbering()).toEqual(sequential)

    // A nested component on its own, and a later sibling, behave the same.
    act(() => triggers.inner())
    act(() => triggers.tail())
    act(() => triggers.outer())
    expect(numbering()).toEqual(sequential)
  })

  // React can run Sidebar's body and then bail out without rendering a single
  // child. The counter is left just past Sidebar's own rows, and the next lone
  // re-render must not mistake that for the start of its own numbering.
  it('ignores a parent body run whose children never rendered', () => {
    render({ guarded: true })

    runParentBody(false)
    act(() => triggers.inner())
    expect(numbering()).toEqual(sequential)

    runParentBody(false)
    act(() => triggers.tail())
    expect(numbering()).toEqual(sequential)
  })

  it('still renumbers on a full pass when rows above it change', () => {
    render({ guarded: true })
    act(() => triggers.outer())

    render({ guarded: true, extraRow: true })

    expect(numbering()).toEqual({
      header: 0,
      extra: 1,
      'outer-1': 2,
      'outer-2': 3,
      'inner-1': 4,
      'inner-2': 5,
      'tail-1': 6,
      'tail-2': 7
    })

    // And the new numbers are the ones a later lone re-render holds on to.
    act(() => triggers.inner())
    expect(numbering()['inner-1']).toBe(4)
    expect(numbering()['tail-1']).toBe(6)
  })
})

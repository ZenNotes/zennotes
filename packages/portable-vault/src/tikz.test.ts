// @vitest-environment jsdom
/**
 * TikZJax finds figures with a MutationObserver on the body. Its callback,
 * copied here from the vendored build (assets/tikzjax/tikzjax.js), queues a
 * `text/tikz` script it is handed, and every such script inside any other
 * element it is handed. A figure queued twice renders into a detached copy
 * whose "finished" event never reaches the document, so the page waits out
 * the 30-second limit (cloud-in-browser-safari-report.md, failure B).
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
import { mountTikzSource } from './tikz'

function observeLikeTikzJax(queued: Element[]): MutationObserver {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes as unknown as Element[]) {
        if (node.tagName && node.tagName.toLowerCase() === 'script' && (node as HTMLScriptElement).type === 'text/tikz') {
          queued.push(node)
        } else if (node.getElementsByTagName) {
          queued.push(...Array.from(node.getElementsByTagName('script')).filter((script) => script.getAttribute('type') === 'text/tikz'))
        }
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return observer
}

let observer: MutationObserver | null = null
afterEach(() => {
  observer?.disconnect()
  document.body.replaceChildren()
})

test('each figure reaches TikZJax once', async () => {
  const queued: Element[] = []
  observer = observeLikeTikzJax(queued)
  const host = mountTikzSource('\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(queued.length, 1)
  assert.equal(queued[0]!.parentElement, host)
  assert.ok(host.isConnected)
})

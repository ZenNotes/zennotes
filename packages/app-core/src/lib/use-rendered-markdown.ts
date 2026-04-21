import { useEffect, useRef, useState } from 'react'
import { recordRendererPerf } from './perf'

export function useSettledMarkdown(
  markdown: string,
  delayMs = 75
): {
  settledMarkdown: string
  isStale: boolean
} {
  const requestedAtRef = useRef(performance.now())
  const [settledMarkdown, setSettledMarkdown] = useState(markdown)

  useEffect(() => {
    requestedAtRef.current = performance.now()
    if (delayMs <= 0) {
      setSettledMarkdown(markdown)
      return
    }
    const timer = window.setTimeout(() => {
      setSettledMarkdown(markdown)
    }, delayMs)
    return () => window.clearTimeout(timer)
  }, [delayMs, markdown])

  useEffect(() => {
    if (settledMarkdown !== markdown) return
    recordRendererPerf('preview.settled-latency', performance.now() - requestedAtRef.current, {
      chars: markdown.length
    })
  }, [markdown, settledMarkdown])

  return {
    settledMarkdown,
    isStale: settledMarkdown !== markdown
  }
}

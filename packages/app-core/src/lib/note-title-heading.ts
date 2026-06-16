export interface BindableH1 {
  lineFrom: number
  lineTo: number
  title: string
}

interface LineSpan {
  text: string
  from: number
  to: number
}

const GENERATED_UNTITLED_TITLE_RE = /^Untitled(?: [1-9]\d*)?$/

export function isGeneratedUntitledTitle(title: string): boolean {
  return GENERATED_UNTITLED_TITLE_RE.test(title.trim())
}

function lineSpans(body: string): LineSpan[] {
  const parts = body.split('\n')
  const lines: LineSpan[] = []
  let offset = 0
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i] ?? ''
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const from = offset
    const to = from + text.length
    lines.push({ text, from, to })
    offset += raw.length + (i < parts.length - 1 ? 1 : 0)
  }
  return lines
}

function h1TitleFromLine(text: string): string | null {
  if (text === '#') return ''
  const match = text.match(/^#[ \t]+(.*)$/u)
  if (!match) return null
  return (match[1] ?? '').replace(/[ \t]+#+[ \t]*$/u, '').trim()
}

export function firstBindableH1(body: string): BindableH1 | null {
  const lines = lineSpans(body)
  let index = 0
  if (lines[0]?.text.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.text.trim() === '---') {
        index = i + 1
        break
      }
    }
  }
  while (index < lines.length && lines[index]?.text.trim() === '') index++
  const line = lines[index]
  if (!line) return null
  const title = h1TitleFromLine(line.text)
  if (title == null) return null
  return { lineFrom: line.from, lineTo: line.to, title }
}

export function bindableH1TitleCursorOffset(body: string): number | null {
  const h1 = firstBindableH1(body)
  if (!h1) return null
  const lineText = body.slice(h1.lineFrom, h1.lineTo)
  const marker = lineText.match(/^#[ \t]*/u)
  if (!marker) return h1.lineTo
  const titleStart = h1.lineFrom + marker[0].length
  if (!h1.title) return titleStart
  const titleIndex = lineText.slice(marker[0].length).indexOf(h1.title)
  if (titleIndex < 0) return h1.lineTo
  return titleStart + titleIndex + h1.title.length
}

function bindableH1InsertOffset(body: string): number {
  const lines = lineSpans(body)
  let index = 0
  if (lines[0]?.text.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.text.trim() === '---') {
        index = i + 1
        break
      }
    }
  }
  while (index < lines.length && lines[index]?.text.trim() === '') index++
  return lines[index]?.from ?? body.length
}

export function ensureBindableH1(body: string, title: string): string {
  if (firstBindableH1(body)) return body
  const h1Line = title.trim() ? `# ${title.trim()}` : '# '
  const offset = bindableH1InsertOffset(body)
  const prefix = body.slice(0, offset)
  const suffix = body.slice(offset)
  const before = prefix && !prefix.endsWith('\n') ? '\n' : ''
  return `${prefix}${before}${h1Line}\n\n${suffix}`
}

export function replaceFirstBindableH1Title(body: string, title: string): string {
  const h1 = firstBindableH1(body)
  if (!h1) return body
  const nextLine = title.trim() ? `# ${title.trim()}` : '# '
  return `${body.slice(0, h1.lineFrom)}${nextLine}${body.slice(h1.lineTo)}`
}

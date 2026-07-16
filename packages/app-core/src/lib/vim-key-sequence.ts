function toVimKeyName(base: string): string {
  if (base === 'Space') return 'Space'
  if (base === 'Enter') return 'CR'
  if (base === 'Esc' || base === 'Escape') return 'Esc'
  if (base === 'Tab') return 'Tab'
  if (base === 'ArrowUp') return 'Up'
  if (base === 'ArrowDown') return 'Down'
  if (base === 'ArrowLeft') return 'Left'
  if (base === 'ArrowRight') return 'Right'
  return base
}

function toVimSequenceToken(token: string): string | null {
  const parts = token
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const base = parts.pop()
  if (!base) return null
  const keyName = toVimKeyName(base)
  if (parts.length === 0) return base.length === 1 ? base : `<${keyName}>`
  const modifiers = parts
    .map((part) => {
      if (part === 'Ctrl') return 'C'
      if (part === 'Alt') return 'A'
      if (part === 'Shift') return 'S'
      if (part === 'Meta' || part === 'Mod') return 'D'
      return null
    })
    .filter(Boolean) as string[]
  const normalizedKey = base.length === 1 ? base.toLowerCase() : keyName
  return `<${[...modifiers, normalizedKey].join('-')}>`
}

export function toVimSequence(binding: string): string | null {
  const tokens = binding
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => toVimSequenceToken(token))
  if (tokens.length === 0 || tokens.some((token) => !token)) return null
  return tokens.join('')
}

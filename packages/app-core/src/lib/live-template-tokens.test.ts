import { describe, expect, it } from 'vitest'
import { formatLiveToken, substituteLiveTokens } from './live-template-tokens'

// 2026-08-25 14:07:09 local time.
const saved = new Date(2026, 7, 25, 14, 7, 9).getTime()

describe('live template tokens (#784)', () => {
  it('renders the three kinds from the note\'s last-saved time', () => {
    expect(substituteLiveTokens('Updated: {{modified_date}}', saved)).toBe('Updated: 2026-08-25')
    expect(substituteLiveTokens('At {{modified_time}}', saved)).toBe('At 14:07')
    expect(substituteLiveTokens('{{ modified_datetime }}', saved)).toBe('2026-08-25 14:07')
  })

  it('takes the same FORMAT tokens as {{date:FORMAT}}', () => {
    expect(substituteLiveTokens('{{modified_date:DD/MM/YYYY}}', saved)).toBe('25/08/2026')
    expect(substituteLiveTokens('{{modified_datetime:yyyy-MM-dd HH:mm:ss}}', saved)).toBe(
      '2026-08-25 14:07:09'
    )
    expect(formatLiveToken({ kind: 'modified_time', format: 'HH[h]mm' }, new Date(saved))).toBe('14h07')
  })

  it('leaves tokens alone inside code and when no modification time is known', () => {
    const body = 'Use `{{modified_date}}` like so:\n```\n{{modified_time}}\n```\n'
    expect(substituteLiveTokens(body, saved)).toBe(body)
    expect(substituteLiveTokens('Updated: {{modified_date}}', null)).toBe('Updated: {{modified_date}}')
    expect(substituteLiveTokens('Updated: {{modified_date}}', 0)).toBe('Updated: {{modified_date}}')
  })

  it('does not touch the creation-time variables or unknown tokens', () => {
    const body = 'Created: {{date}} {{time}} {{title}} {{unknown}} {{modified}}'
    expect(substituteLiveTokens(body, saved)).toBe(body)
  })
})

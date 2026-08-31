import { describe, expect, it } from 'vitest'
import { getSessionKey, splitLong } from '../src/index.js'

describe('splitLong', () => {
  it('returns the text as-is when it fits', () => {
    expect(splitLong('hello')).toEqual(['hello'])
  })

  it('splits long text at newline boundaries', () => {
    const text = 'a'.repeat(4500)
    const parts = splitLong(text)
    expect(parts.length).toBe(2)
    expect(parts.every((p) => p.length <= 4000)).toBe(true)
    expect(parts.join('')).toBe(text)
  })

  it('hard-cuts when a single line exceeds the limit', () => {
    const text = 'x'.repeat(9000)
    const parts = splitLong(text)
    expect(parts.length).toBe(3)
    expect(parts.join('')).toBe(text)
  })

  it('prefers the last newline before the limit', () => {
    const text = 'a'.repeat(3900) + '\n' + 'b'.repeat(500)
    const parts = splitLong(text, 4000)
    expect(parts[0]).toBe('a'.repeat(3900))
    expect(parts[1]).toBe('b'.repeat(500))
  })
})

describe('getSessionKey', () => {
  it('uses the chat id when topic support is disabled', () => {
    expect(getSessionKey(123, 456, false)).toBe('123')
  })

  it('uses the chat id when topic support is enabled but no topic id exists', () => {
    expect(getSessionKey(123, undefined, true)).toBe('123')
  })

  it('uses chat and topic ids when topic support is enabled', () => {
    expect(getSessionKey(123, 456, true)).toBe('123:456')
  })
})

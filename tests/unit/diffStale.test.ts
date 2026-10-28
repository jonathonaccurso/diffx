import { describe, expect, it } from 'vitest'
import { contentSignature, isDiffStale } from '../../src/ui/utils'

describe('isDiffStale', () => {
  it('is false when the fingerprints match', () => {
    expect(isDiffStale('abc', 'abc')).toBe(false)
  })

  it('is true when the fingerprints differ', () => {
    expect(isDiffStale('abc', 'def')).toBe(true)
  })

  it('is false until both fingerprints are known', () => {
    expect(isDiffStale(null, 'abc')).toBe(false)
    expect(isDiffStale('abc', null)).toBe(false)
    expect(isDiffStale(null, null)).toBe(false)
  })
})

describe('contentSignature', () => {
  it('is stable for equal content', () => {
    expect(contentSignature(['a\n', 'b\n'])).toBe(contentSignature(['a\n', 'b\n']))
  })

  it('changes when a line changes', () => {
    expect(contentSignature(['a\n', 'b\n'])).not.toBe(contentSignature(['a\n', 'c\n']))
  })

  it('changes when a line is appended', () => {
    expect(contentSignature(['a\n'])).not.toBe(contentSignature(['a\n', 'b\n']))
  })

  it('tells line boundaries apart', () => {
    expect(contentSignature(['ab', 'c'])).not.toBe(contentSignature(['a', 'bc']))
  })
})

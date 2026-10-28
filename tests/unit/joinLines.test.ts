import { describe, expect, it } from 'vitest'
import { joinLines } from '../../src/ui/utils'
import { formatComments } from '../../src/commentFormat'
import { parseCommentExport } from '../../src/commentImport'
import type { ReviewComment } from '../../src/types'

describe('joinLines', () => {
  it('adds nothing between lines that carry their own terminator', () => {
    expect(joinLines(['a\n', 'b\n', 'c\n'])).toBe('a\nb\nc\n')
  })

  it('adds a line break after unterminated lines except the last', () => {
    expect(joinLines(['a', 'b', 'c'])).toBe('a\nb\nc')
  })

  it('keeps CRLF terminators as they are', () => {
    expect(joinLines(['a\r\n', 'b\r\n', 'c\r\n'])).toBe('a\r\nb\r\nc\r\n')
  })

  it('mixes terminated and unterminated lines', () => {
    expect(joinLines(['a\r\n', 'b', 'c\n'])).toBe('a\r\nb\nc\n')
  })

  it('leaves a last line without a newline unterminated', () => {
    expect(joinLines(['a\n', 'b'])).toBe('a\nb')
  })

  it('returns a single line unchanged', () => {
    expect(joinLines(['a\n'])).toBe('a\n')
    expect(joinLines(['a'])).toBe('a')
  })

  it('treats an empty string line in the middle as unterminated', () => {
    expect(joinLines(['a\n', '', 'c\n'])).toBe('a\n\nc\n')
  })

  it('returns an empty string for no lines', () => {
    expect(joinLines([])).toBe('')
  })

  it.each([
    ['terminated', ['a\n', 'b\n']],
    ['unterminated last line', ['a\n', 'b']],
    ['CRLF', ['a\r\n', 'b\r\n']],
    ['blank line in the middle', ['a\n', '\n', 'c\n']],
  ])('survives the comment export round trip (%s)', (_name, lines) => {
    const lineContent = joinLines(lines)
    const comment: ReviewComment = {
      id: 'c1',
      filePath: 'a.txt',
      side: 'additions',
      lineNumber: lines.length + 1,
      startLineNumber: 2,
      lineContent,
      body: 'span comment',
      status: 'open',
      createdAt: 0,
      replies: [],
    }

    const { comments, unreadable } = parseCommentExport(formatComments([comment]))

    expect(unreadable).toBe(0)
    expect(comments).toHaveLength(1)
    expect(comments[0].lineContent).toBe(lineContent)
    expect(comments[0].body).toBe('span comment')
  })
})

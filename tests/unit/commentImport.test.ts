import { describe, expect, it } from 'vitest'
import { importComments, parseCommentExport } from '../../src/commentImport.js'
import { InMemoryCommentStore } from '../../src/comments.js'
import { formatComments } from '../../src/commentFormat.js'
import type { ReviewComment } from '../../src/types.js'

function exportOf(...blocks: string[]): string {
  return ['<code-review-comments>', '<file path="greet.ts">', ...blocks, '</file>', '</code-review-comments>'].join('\n')
}

function commentBlock(line: string, prefix: '+' | '-', code: string, body: string, status?: 'resolved'): string {
  const statusAttr = status ? ` status="${status}"` : ''
  const codeLines = code.split('\n').map((l) => `${prefix} ${l}`).join('\n')
  return [`<comment line="${line}"${statusAttr}>`, `<code>${codeLines}</code>`, body, '</comment>'].join('\n')
}

function makeStoredComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'existing-1',
    filePath: 'greet.ts',
    side: 'additions',
    lineNumber: 2,
    lineContent: "  const message = `Hello, ${name}!`",
    body: 'First comment',
    status: 'open',
    createdAt: Date.now(),
    replies: [],
    ...overrides,
  }
}

describe('parseCommentExport', () => {
  it('reads a single-file, two-comment export', () => {
    const text = exportOf(
      commentBlock('2', '+', "  const message = `Hello, ${name}!`", 'First comment'),
      commentBlock('3', '+', '  return message', 'Second comment'),
    )

    const result = parseCommentExport(text)

    expect(result.unreadable).toBe(0)
    expect(result.comments).toHaveLength(2)
    expect(result.comments[0]).toEqual({
      filePath: 'greet.ts',
      side: 'additions',
      lineNumber: 2,
      startLineNumber: undefined,
      lineContent: "  const message = `Hello, ${name}!`",
      body: 'First comment',
      status: 'open',
    })
    expect(result.comments[1]).toEqual({
      filePath: 'greet.ts',
      side: 'additions',
      lineNumber: 3,
      startLineNumber: undefined,
      lineContent: '  return message',
      body: 'Second comment',
      status: 'open',
    })
  })

  it('round-trips a multi-line comment, keeping its start and end line', () => {
    const text = exportOf(commentBlock('2-3', '+', '  const message = `Hello, ${name}!`\n  return message', 'Multi-line comment'))

    const result = parseCommentExport(text)

    expect(result.unreadable).toBe(0)
    expect(result.comments[0].startLineNumber).toBe(2)
    expect(result.comments[0].lineNumber).toBe(3)
    expect(result.comments[0].lineContent).toBe('  const message = `Hello, ${name}!`\n  return message')
  })

  it('round-trips lineContent that ends in a trailing newline', () => {
    const text = exportOf(commentBlock('2', '+', 'first line\n', 'body'))

    const result = parseCommentExport(text)

    expect(result.unreadable).toBe(0)
    expect(result.comments[0].lineContent).toBe('first line\n')
  })

  it('marks a comment resolved only when the export says so', () => {
    const text = exportOf(commentBlock('2', '+', 'line', 'body', 'resolved'))

    const result = parseCommentExport(text)

    expect(result.comments[0].status).toBe('resolved')
  })

  it('returns unreadable:0 and no comments when the text has no <code-review-comments> block', () => {
    const result = parseCommentExport('First comment\nSecond comment')

    expect(result).toEqual({ comments: [], unreadable: 0 })
  })
})

describe('importComments', () => {
  it('skips a duplicate by path, side, range, and trimmed body', async () => {
    const store = new InMemoryCommentStore()
    await store.add(makeStoredComment())
    const text = exportOf(commentBlock('2', '+', "  const message = `Hello, ${name}!`", 'First comment  '))

    const result = await importComments(store, text)

    expect(result.imported).toBe(0)
    expect(result.duplicates).toBe(1)
    expect(result.unreadable).toBe(0)
    expect(await store.getAll()).toHaveLength(1)
  })

  it('imports a comment edited after export as new, not a duplicate', async () => {
    const store = new InMemoryCommentStore()
    await store.add(makeStoredComment())
    const text = exportOf(commentBlock('2', '+', "  const message = `Hello, ${name}!`", 'First comment, edited'))

    const result = await importComments(store, text)

    expect(result.imported).toBe(1)
    expect(result.duplicates).toBe(0)
    expect(await store.getAll()).toHaveLength(2)
  })

  it('assigns a new id and createdAt, and defaults status to open', async () => {
    const store = new InMemoryCommentStore()
    const text = exportOf(commentBlock('2', '+', 'line', 'a new comment'))

    const result = await importComments(store, text)

    expect(result.imported).toBe(1)
    const [created] = result.comments
    expect(created.id).toBeTruthy()
    expect(typeof created.createdAt).toBe('number')
    expect(created.status).toBe('open')
    expect(created.replies).toEqual([])
  })

  it('returns unreadable:0/empty and changes nothing when the text has no comments block', async () => {
    const store = new InMemoryCommentStore()

    const result = await importComments(store, 'not an export')

    expect(result).toEqual({ imported: 0, duplicates: 0, unreadable: 0, comments: [] })
    expect(await store.getAll()).toHaveLength(0)
  })

  it('round-trips a resolved comment through formatAllComments and preserves its status', async () => {
    const store = new InMemoryCommentStore()
    const resolved = await store.add({
      id: 'test-resolved',
      filePath: 'greet.ts',
      side: 'additions',
      lineNumber: 2,
      lineContent: '  const message = `Hello, ${name}!`',
      body: 'This is resolved',
      status: 'resolved',
      createdAt: Date.now(),
      replies: [],
    })

    // Export the resolved comment
    const exported = ['<code-review-comments>', '<file path="greet.ts">', commentBlock('2', '+', "  const message = `Hello, ${name}!`", 'This is resolved', 'resolved'), '</file>', '</code-review-comments>'].join('\n')

    // Parse it back
    const parsed = parseCommentExport(exported)

    expect(parsed.unreadable).toBe(0)
    expect(parsed.comments).toHaveLength(1)
    expect(parsed.comments[0].status).toBe('resolved')
  })
})

describe('reply authors in the export', () => {
  const replies = [
    { id: 'r1', body: 'Fixed it.', createdAt: 1 },
    { id: 'r2', body: 'Still wrong.', createdAt: 2, author: 'reviewer' as const },
  ]

  it('writes each reply with its author, defaulting to agent', () => {
    const text = formatComments([
      makeStoredComment({ replies }),
      makeStoredComment({ id: 'c2', scope: 'file', body: 'file note', replies: [replies[1]] }),
      makeStoredComment({ id: 'c3', scope: 'diff', filePath: '', body: 'diff note', replies: [replies[0]] }),
    ])
    expect(text).toContain('<reply author="agent">\nFixed it.\n</reply>')
    expect(text).toContain('<reply author="reviewer">\nStill wrong.\n</reply>')
    expect(text.match(/<reply author="/g)).toHaveLength(4)
  })

  it('leaves replies out of the imported body', async () => {
    const text = formatComments([
      makeStoredComment({ body: 'line note', replies }),
      makeStoredComment({ id: 'c2', scope: 'file', body: 'file note', replies }),
    ])
    const store = new InMemoryCommentStore()
    const result = await importComments(store, text)
    expect(result.imported).toBe(2)
    expect(result.comments.map((c) => c.body).sort()).toEqual(['file note', 'line note'])
  })
})

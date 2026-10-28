import { describe, expect, it } from 'vitest'
import { replyAuthor, threadState } from '../../src/threadState'
import type { ReviewComment } from '../../src/types'

function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    filePath: 'greet.ts',
    side: 'additions',
    lineNumber: 2,
    lineContent: 'line',
    body: 'a comment',
    status: 'open',
    createdAt: 1,
    replies: [],
    ...overrides,
  }
}

describe('replyAuthor', () => {
  it('treats a missing or unknown author as the agent', () => {
    expect(replyAuthor({ id: 'r', body: 'x', createdAt: 1 })).toBe('agent')
    expect(replyAuthor({ id: 'r', body: 'x', createdAt: 1, author: 'reviewer' })).toBe('reviewer')
    expect(replyAuthor({ id: 'r', body: 'x', createdAt: 1, author: 'other' as 'agent' })).toBe('agent')
  })
})

describe('threadState', () => {
  it('waits for the agent when an open comment has no reply', () => {
    expect(threadState(makeComment())).toBe('waiting-agent')
  })

  it('waits for the agent when the last reply is the reviewer', () => {
    const replies = [
      { id: 'r1', body: 'a', createdAt: 1 },
      { id: 'r2', body: 'b', createdAt: 2, author: 'reviewer' as const },
    ]
    expect(threadState(makeComment({ replies }))).toBe('waiting-agent')
  })

  it('waits for the reviewer when the last reply is the agent, with or without an author', () => {
    const reviewer = { id: 'r1', body: 'a', createdAt: 1, author: 'reviewer' as const }
    expect(threadState(makeComment({ replies: [reviewer, { id: 'r2', body: 'b', createdAt: 2 }] }))).toBe(
      'waiting-reviewer',
    )
    expect(
      threadState(makeComment({ replies: [reviewer, { id: 'r2', body: 'b', createdAt: 2, author: 'agent' }] })),
    ).toBe('waiting-reviewer')
  })

  it('is resolved whatever the replies say', () => {
    const replies = [{ id: 'r1', body: 'a', createdAt: 1, author: 'reviewer' as const }]
    expect(threadState(makeComment({ status: 'resolved', replies }))).toBe('resolved')
  })
})

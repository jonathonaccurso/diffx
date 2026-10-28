import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CommentBubble } from '../../src/ui/components/CommentBubble'
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
    createdAt: Date.now(),
    replies: [],
    ...overrides,
  }
}

function render(comment: ReviewComment): string {
  return renderToStaticMarkup(
    createElement(CommentBubble, { comment, onDelete: () => {}, onEdit: () => {}, onReply: () => {} }),
  )
}

describe('CommentBubble', () => {
  it('renders an Edit comment button for an open comment', () => {
    expect(render(makeComment())).toContain('Edit comment')
  })

  it('renders no Edit comment button for a resolved comment', () => {
    expect(render(makeComment({ status: 'resolved' }))).not.toContain('Edit comment')
  })

  it('shows an edited label when editedAt is set', () => {
    expect(render(makeComment({ editedAt: Date.now() }))).toContain('edited')
  })

  it('shows no edited label when editedAt is absent', () => {
    expect(render(makeComment())).not.toContain('edited')
  })

  it('renders a Reply button on every thread', () => {
    expect(render(makeComment())).toContain('comment-reply-open')
    expect(render(makeComment({ status: 'resolved' }))).toContain('comment-reply-open')
  })

  it('labels a reviewer reply Reviewer and an agent reply Agent', () => {
    const html = render(
      makeComment({
        replies: [
          { id: 'r1', body: 'agent says', createdAt: 1 },
          { id: 'r2', body: 'explicit agent', createdAt: 2, author: 'agent' },
          { id: 'r3', body: 'reviewer says', createdAt: 3, author: 'reviewer' },
        ],
      }),
    )
    expect(html.match(/data-author="agent"/g)).toHaveLength(2)
    expect(html.match(/data-author="reviewer"/g)).toHaveLength(1)
    expect(html).toContain('comment-reply-avatar-reviewer')
  })
})

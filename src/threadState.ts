import type { ReplyAuthor, CommentReply, ReviewComment } from './types.js'

export type ThreadState = 'waiting-agent' | 'waiting-reviewer' | 'resolved'

export function replyAuthor(reply: CommentReply): ReplyAuthor {
  return reply.author === 'reviewer' ? 'reviewer' : 'agent'
}

// An open thread waits for the agent until the agent has the last word.
export function threadState(comment: ReviewComment): ThreadState {
  if (comment.status === 'resolved') return 'resolved'
  const last = comment.replies?.[comment.replies.length - 1]
  return last && replyAuthor(last) === 'agent' ? 'waiting-reviewer' : 'waiting-agent'
}

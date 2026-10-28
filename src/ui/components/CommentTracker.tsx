import {
  MessageSquare,
  CheckCircle2,
  Reply,
  Hourglass,
} from 'lucide-react'
import type { ReviewComment } from '../../types'
import { timeAgo, truncate, fileName } from '../utils'
import { threadState } from '../../threadState'
import type { ThreadState } from '../../threadState'

interface CommentTrackerProps {
  comments: ReviewComment[]
}

const STATE_LABEL: Record<ThreadState, string> = {
  'waiting-agent': 'Waiting for agent',
  'waiting-reviewer': 'Agent replied, waiting for you',
  resolved: 'Resolved',
}

function StatusBadge({ state }: { state: ThreadState }) {
  return (
    <span className={`ct-status ct-status-${state}`} title={STATE_LABEL[state]} data-thread-state={state}>
      {state === 'waiting-agent' && <Hourglass size={12} />}
      {state === 'waiting-reviewer' && <Reply size={12} />}
      {state === 'resolved' && <CheckCircle2 size={12} />}
    </span>
  )
}

export function CommentTracker({ comments }: CommentTrackerProps) {
  if (comments.length === 0) return null

  const sorted = [...comments].sort((a, b) => b.createdAt - a.createdAt)

  const countOf = (state: ThreadState) => sorted.filter((c) => threadState(c) === state).length
  const agentCount = countOf('waiting-agent')
  const reviewerCount = countOf('waiting-reviewer')
  const resolvedCount = countOf('resolved')

  return (
    <div className="ct">
      <div className="ct-header">
        <MessageSquare size={14} />
        <span className="ct-title">Comments</span>
        <span className="ct-counts">
          {agentCount > 0 && (
            <span className="ct-count ct-count-waiting-agent">{agentCount} waiting for agent</span>
          )}
          {reviewerCount > 0 && (
            <span className="ct-count ct-count-waiting-reviewer">{reviewerCount} waiting for you</span>
          )}
          {resolvedCount > 0 && <span className="ct-count ct-count-resolved">{resolvedCount} resolved</span>}
        </span>
      </div>
      <ul className="ct-list">
        {sorted.map((comment) => {
          const state = threadState(comment)
          return (
            <li
              key={comment.id}
              className={`ct-item ${state === 'resolved' ? 'ct-item-resolved' : ''}`}
            >
              <a href={`#comment-${comment.id}`} className="ct-item-link">
                <div className="ct-item-header">
                  <StatusBadge state={state} />
                  <span className="ct-item-file" title={comment.filePath}>
                    {comment.scope === 'diff'
                      ? 'Whole diff'
                      : comment.scope === 'file'
                        ? fileName(comment.filePath)
                        : `${fileName(comment.filePath)}:${
                            comment.startLineNumber != null && comment.startLineNumber !== comment.lineNumber
                              ? `${comment.startLineNumber}-${comment.lineNumber}`
                              : comment.lineNumber
                          }`}
                  </span>
                  <span className="ct-item-time">{timeAgo(comment.createdAt)}</span>
                </div>
                <div className="ct-item-body">{truncate(comment.body, 80)}</div>
              </a>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

import { useState, useEffect } from 'react'
import { UserCircle, CheckCircle2, Bot } from 'lucide-react'
import type { ReviewComment } from '../../types'
import { replyAuthor } from '../../threadState'
import { timeAgo } from '../utils'
import { CommentForm } from './CommentForm'

interface CommentBubbleProps {
  comment: ReviewComment
  onDelete: (id: string) => void
  onEdit: (id: string, body: string) => void
  onReply: (id: string, body: string) => void
}

export function CommentBubble({ comment, onDelete, onEdit, onReply }: CommentBubbleProps) {
  const [, setTick] = useState(0)
  // Editing state is kept in this component instance rather than in a
  // sibling/free-standing form, for the same reason FileDiffCard keeps its
  // pending-new-comment state in itself rather than in the annotation it
  // renders: this component is never unmounted by the virtualizer (only its
  // rendered content is windowed), so the draft survives the file scrolling
  // out of view and back.
  const [editing, setEditing] = useState(false)
  const [replying, setReplying] = useState(false)
  const isResolved = comment.status === 'resolved'
  const isMultiLine = comment.startLineNumber != null && comment.startLineNumber !== comment.lineNumber

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className={`comment-bubble ${isResolved ? 'comment-resolved' : ''}`} id={`comment-${comment.id}`}>
      {editing ? (
        <CommentForm
          initialBody={comment.body}
          submitLabel="Save"
          onSubmit={(body) => {
            onEdit(comment.id, body)
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="comment-bubble-header">
            <UserCircle size={18} className="comment-bubble-avatar" />
            {isMultiLine && (
              <span className="comment-bubble-range">
                Lines {comment.startLineNumber}-{comment.lineNumber}
              </span>
            )}
            <span className="comment-bubble-time">{timeAgo(comment.createdAt)}</span>
            {comment.editedAt != null && <span className="comment-bubble-edited">edited</span>}
            {isResolved && (
              <span className="comment-bubble-resolved">
                <CheckCircle2 size={14} />
                Resolved
              </span>
            )}
            {!isResolved && (
              <div className="comment-bubble-actions">
                <button className="comment-bubble-edit" onClick={() => setEditing(true)}>
                  Edit comment
                </button>
                <button
                  className="comment-bubble-delete"
                  onClick={() => onDelete(comment.id)}
                  title="Delete comment"
                >
                  &times;
                </button>
              </div>
            )}
          </div>
          <div className="comment-bubble-body">{comment.body}</div>
        </>
      )}
      {comment.replies?.length > 0 && (
        <div className="comment-replies">
          {comment.replies.map((reply) => {
            const author = replyAuthor(reply)
            return (
              <div key={reply.id} className="comment-reply" data-author={author}>
                <div className="comment-reply-header">
                  {author === 'reviewer' ? (
                    <UserCircle size={16} className="comment-reply-avatar comment-reply-avatar-reviewer" />
                  ) : (
                    <Bot size={16} className="comment-reply-avatar" />
                  )}
                  <span className="comment-reply-author">{author === 'reviewer' ? 'Reviewer' : 'Agent'}</span>
                  <span className="comment-bubble-time">{timeAgo(reply.createdAt)}</span>
                </div>
                <div className="comment-reply-body">{reply.body}</div>
              </div>
            )
          })}
        </div>
      )}
      <div className="comment-reply-box">
        {replying ? (
          <CommentForm
            placeholder="Reply..."
            submitLabel="Reply"
            onSubmit={(body) => {
              onReply(comment.id, body)
              setReplying(false)
            }}
            onCancel={() => setReplying(false)}
          />
        ) : (
          <button className="comment-reply-open" onClick={() => setReplying(true)}>
            Reply
          </button>
        )}
      </div>
    </div>
  )
}

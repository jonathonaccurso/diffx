import { useState, memo } from 'react'
import { FileDiff } from '@pierre/diffs/react'
import type { DiffLineAnnotation, FileDiffMetadata, AnnotationSide, SelectedLineRange } from '@pierre/diffs'
import type { ReviewComment } from '../../types'
import { CommentForm } from './CommentForm'
import { CommentBubble } from './CommentBubble'

interface PendingComment {
  side: AnnotationSide
  startLine: number
  endLine: number
}

interface FileDiffCardProps {
  id?: string
  fileDiff: FileDiffMetadata
  filePath: string
  annotations: DiffLineAnnotation<ReviewComment>[]
  fileComments: ReviewComment[]
  onAddFileComment: (scope: 'file' | 'diff', filePath: string, body: string) => void
  diffStyle: 'split' | 'unified'
  tabSize: number
  softWrap: boolean
  viewed: boolean
  onViewedChange: (filePath: string, viewed: boolean) => void
  onAddComment: (
    filePath: string,
    side: AnnotationSide,
    startLine: number,
    endLine: number,
    lineContent: string,
    body: string,
  ) => void
  onDeleteComment: (id: string) => void
  onEditComment: (id: string, body: string) => void
  onReplyComment: (id: string, body: string) => void
}

export const FileDiffCard = memo(function FileDiffCard({
  id,
  fileDiff,
  filePath,
  annotations,
  fileComments,
  onAddFileComment,
  diffStyle,
  tabSize,
  softWrap,
  viewed,
  onViewedChange,
  onAddComment,
  onDeleteComment,
  onEditComment,
  onReplyComment,
}: FileDiffCardProps) {
  const [composingFileComment, setComposingFileComment] = useState(false)
  const [pending, setPending] = useState<PendingComment | null>(null)
  // Controlled so it can be cleared when the composer closes: while the
  // library holds a selection it pins the "+" to it and ignores hover.
  const [selection, setSelection] = useState<SelectedLineRange | null>(null)

  const getLineContent = (side: AnnotationSide, lineNumber: number): string => {
    const lines = side === 'additions' ? fileDiff.additionLines : fileDiff.deletionLines
    // Full (non-partial) diffs carry the entire file, so any line — including
    // expanded context outside hunks — can be addressed directly.
    if (!fileDiff.isPartial) {
      return lines[lineNumber - 1] ?? ''
    }
    const startKey = side === 'additions' ? 'additionStart' : 'deletionStart'
    const countKey = side === 'additions' ? 'additionCount' : 'deletionCount'
    const indexKey = side === 'additions' ? 'additionLineIndex' : 'deletionLineIndex'
    for (const hunk of fileDiff.hunks) {
      const start = hunk[startKey]
      const count = hunk[countKey]
      if (lineNumber >= start && lineNumber < start + count) {
        const index = hunk[indexKey] + (lineNumber - start)
        return lines[index] ?? ''
      }
    }
    return ''
  }

  const getLineRangeContent = (side: AnnotationSide, startLine: number, endLine: number): string => {
    const content: string[] = []
    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
      content.push(getLineContent(side, lineNumber))
    }
    return content.join('\n')
  }

  const allAnnotations: DiffLineAnnotation<ReviewComment | { _pending: true }>[] = [
    ...annotations,
    ...(pending
      ? [
          {
            side: pending.side,
            lineNumber: pending.endLine,
            metadata: { _pending: true as const },
          },
        ]
      : []),
  ]

  return (
    <div className={`file-diff-card ${viewed ? 'file-diff-viewed' : ''}`} id={id}>
      <div className="file-comments">
        {fileComments.map((comment) => (
          <CommentBubble key={comment.id} comment={comment} onDelete={onDeleteComment} onEdit={onEditComment} onReply={onReplyComment} />
        ))}
        {composingFileComment && (
          <CommentForm
            placeholder={`Comment on ${filePath}...`}
            onSubmit={(body) => {
              onAddFileComment('file', filePath, body)
              setComposingFileComment(false)
            }}
            onCancel={() => setComposingFileComment(false)}
          />
        )}
      </div>
      {viewed ? (
        <div className="file-diff-viewed-header">
          <span className="file-diff-viewed-name">{filePath}</span>
          <label className="viewed-label viewed-checked" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={viewed}
              onChange={(e) => onViewedChange(filePath, e.target.checked)}
            />
            Viewed
          </label>
        </div>
      ) : (
        <>
          <FileDiff<ReviewComment | { _pending: true }>
            fileDiff={fileDiff}
            options={{
              diffStyle,
              stickyHeader: true,
              expansionLineCount: 20,
              enableGutterUtility: true,
              enableLineSelection: true,
              onLineSelectionStart: setSelection,
              onLineSelectionChange: setSelection,
              onLineSelected: setSelection,
              onGutterUtilityClick: (range: SelectedLineRange) => {
                const side = range.side ?? range.endSide ?? 'additions'
                setPending({
                  side,
                  startLine: Math.min(range.start, range.end),
                  endLine: Math.max(range.start, range.end),
                })
              },
              theme: { dark: 'github-dark', light: 'github-light' },
              themeType: 'system',
              overflow: softWrap ? 'wrap' : 'scroll',
              unsafeCSS: `:host { --diffs-tab-size: ${tabSize}; }`,
            }}
            lineAnnotations={allAnnotations}
            selectedLines={selection}
            renderHeaderMetadata={() => (
              <>
                <button
                  className="file-comment-add"
                  title="Comment on this file"
                  onClick={(e) => {
                    e.stopPropagation()
                    setComposingFileComment(true)
                  }}
                >
                  Comment
                </button>
                <label className="viewed-label" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={viewed}
                  onChange={(e) => onViewedChange(filePath, e.target.checked)}
                />
                Viewed
              </label>
              </>
            )}
            renderAnnotation={(annotation) => {
              if ('_pending' in annotation.metadata) {
                return (
                  <CommentForm
                    lineRange={pending!.startLine === pending!.endLine ? undefined : [pending!.startLine, pending!.endLine]}
                    onSubmit={(body) => {
                      const lineContent = getLineRangeContent(pending!.side, pending!.startLine, pending!.endLine)
                      onAddComment(filePath, pending!.side, pending!.startLine, pending!.endLine, lineContent, body)
                      setPending(null)
                      setSelection(null)
                    }}
                    onCancel={() => {
                      setPending(null)
                      setSelection(null)
                    }}
                  />
                )
              }
              return (
                <CommentBubble
                  comment={annotation.metadata as ReviewComment}
                  onDelete={onDeleteComment}
                  onEdit={onEditComment}
                  onReply={onReplyComment}
                />
              )
            }}
          />
        </>
      )}
    </div>
  )
})

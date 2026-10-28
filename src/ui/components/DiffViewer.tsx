import { memo, useCallback, useMemo, useState } from 'react'
import type { FileDiffMetadata, DiffLineAnnotation, AnnotationSide } from '@pierre/diffs'
import type { ReviewComment } from '../../types'
import type { BinaryFileInfo } from '../hooks/useDiff'
import { FileDiffCard } from './FileDiffCard'
import { BinaryFileDiff } from './BinaryFileDiff'
import { CommentBubble } from './CommentBubble'
import { CommentForm } from './CommentForm'

interface DiffViewerProps {
  files: FileDiffMetadata[]
  diffStyle: 'split' | 'unified'
  tabSizeMap: Record<string, number>
  defaultTabSize: number
  softWrap: boolean
  viewedFiles: Set<string>
  binaryFiles: Map<string, BinaryFileInfo>
  onViewedChange: (filePath: string, viewed: boolean) => void
  fileAnnotationsMap: Map<string, DiffLineAnnotation<ReviewComment>[]>
  fileCommentsMap: Map<string, ReviewComment[]>
  diffComments: ReviewComment[]
  onAddScopedComment: (scope: 'file' | 'diff', filePath: string, body: string) => void
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

export function nextUnviewedFile(
  sortedNames: string[],
  current: string,
  viewedFiles: Set<string>,
): string | undefined {
  const index = sortedNames.indexOf(current)
  return sortedNames.slice(index + 1).find((name) => !viewedFiles.has(name))
}

const emptyAnnotations: DiffLineAnnotation<ReviewComment>[] = []
const emptyComments: ReviewComment[] = []

export const DiffViewer = memo(function DiffViewer({
  files,
  diffStyle,
  tabSizeMap,
  defaultTabSize,
  softWrap,
  viewedFiles,
  binaryFiles,
  onViewedChange,
  fileAnnotationsMap,
  fileCommentsMap,
  diffComments,
  onAddScopedComment,
  onAddComment,
  onDeleteComment,
  onEditComment,
  onReplyComment,
}: DiffViewerProps) {
  const sortedFiles = useMemo(() => {
    return [...files].sort((a, b) => {
      const partsA = a.name.split('/')
      const partsB = b.name.split('/')
      const len = Math.min(partsA.length, partsB.length)
      for (let i = 0; i < len; i++) {
        const aIsDir = i < partsA.length - 1
        const bIsDir = i < partsB.length - 1
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
        const cmp = partsA[i].localeCompare(partsB[i])
        if (cmp !== 0) return cmp
      }
      return partsA.length - partsB.length
    })
  }, [files])

  const handleViewedChange = useCallback(
    (filePath: string, viewed: boolean) => {
      onViewedChange(filePath, viewed)
      if (!viewed) return
      const next = nextUnviewedFile(
        sortedFiles.map((f) => f.name),
        filePath,
        viewedFiles,
      )
      if (!next) return
      // Wait for the viewed card to collapse before measuring the target's position.
      requestAnimationFrame(() => {
        document.getElementById(`file-${next}`)?.scrollIntoView({ block: 'start' })
      })
    },
    [onViewedChange, sortedFiles, viewedFiles],
  )

  const [composingDiffComment, setComposingDiffComment] = useState(false)

  if (sortedFiles.length === 0) {
    return (
      <div className="empty-state">
        <p>No changes found.</p>
      </div>
    )
  }

  return (
    <div className="diff-viewer">
      <div className="diff-comments">
        {diffComments.map((comment) => (
          <CommentBubble key={comment.id} comment={comment} onDelete={onDeleteComment} onEdit={onEditComment} onReply={onReplyComment} />
        ))}
        {composingDiffComment ? (
          <CommentForm
            placeholder="Comment on the whole diff..."
            onSubmit={(body) => {
              onAddScopedComment('diff', '', body)
              setComposingDiffComment(false)
            }}
            onCancel={() => setComposingDiffComment(false)}
          />
        ) : (
          <button className="btn btn-secondary diff-comment-add" onClick={() => setComposingDiffComment(true)}>
            Comment on diff
          </button>
        )}
      </div>
      {sortedFiles.map((file, index) => {
        const filePath = file.name
        const binaryInfo = binaryFiles.get(filePath)
        if (binaryInfo) {
          return (
            <BinaryFileDiff
              key={`${filePath}-${index}`}
              filePath={filePath}
              info={binaryInfo}
              viewed={viewedFiles.has(filePath)}
              onViewedChange={handleViewedChange}
            />
          )
        }
        return (
          <FileDiffCard
            // Include isPartial in the key so the card remounts when a file is
            // upgraded from a partial (patch-only) to a full diff. The
            // @pierre/diffs <FileDiff> under the Virtualizer does not re-process
            // an in-place fileDiff change, so without a remount the upgraded
            // diff never renders and hunk-context expansion controls never appear.
            key={`${filePath}-${index}-${file.isPartial ? 'p' : 'f'}`}
            id={`file-${filePath}`}
            fileDiff={file}
            filePath={filePath}
            annotations={fileAnnotationsMap.get(filePath) ?? emptyAnnotations}
            fileComments={fileCommentsMap.get(filePath) ?? emptyComments}
            onAddFileComment={onAddScopedComment}
            diffStyle={diffStyle}
            tabSize={tabSizeMap[filePath] ?? defaultTabSize}
            softWrap={softWrap}
            viewed={viewedFiles.has(filePath)}
            onViewedChange={handleViewedChange}
            onAddComment={onAddComment}
            onDeleteComment={onDeleteComment}
            onEditComment={onEditComment}
            onReplyComment={onReplyComment}
          />
        )
      })}
    </div>
  )
})

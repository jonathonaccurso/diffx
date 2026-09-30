import type { ReviewComment } from './types.js'

export function commentScope(comment: ReviewComment): 'line' | 'file' | 'diff' {
  return comment.scope ?? 'line'
}

// Serializes comments into the "Copy comments" export that
// `parseCommentExport` reads back.
export function formatComments(comments: ReviewComment[]): string {
  if (comments.length === 0) return ''

  const lines: string[] = ['<code-review-comments>']
  const statusOf = (c: ReviewComment) => (c.status === 'resolved' ? ' status="resolved"' : '')

  for (const comment of comments.filter((c) => commentScope(c) === 'diff')) {
    lines.push(`<comment scope="diff"${statusOf(comment)}>`, comment.body, '</comment>')
  }

  const grouped = new Map<string, ReviewComment[]>()
  for (const comment of comments) {
    if (commentScope(comment) === 'diff') continue
    const list = grouped.get(comment.filePath) ?? []
    list.push(comment)
    grouped.set(comment.filePath, list)
  }

  for (const [filePath, fileComments] of grouped) {
    lines.push(`<file path="${filePath}">`)
    for (const comment of fileComments) {
      if (commentScope(comment) === 'file') {
        lines.push(`<comment scope="file"${statusOf(comment)}>`, comment.body, '</comment>')
        continue
      }
      const lineLabel =
        comment.startLineNumber != null && comment.startLineNumber !== comment.lineNumber
          ? `${comment.startLineNumber}-${comment.lineNumber}`
          : `${comment.lineNumber}`
      lines.push(`<comment line="${lineLabel}"${statusOf(comment)}>`)
      const prefix = comment.side === 'additions' ? '+' : '-'
      const code = comment.lineContent
        .split('\n')
        .map((line) => `${prefix} ${line}`)
        .join('\n')
      lines.push(`<code>${code}</code>`)
      lines.push(comment.body)
      lines.push('</comment>')
    }
    lines.push('</file>')
  }
  lines.push('</code-review-comments>')

  return lines.join('\n')
}

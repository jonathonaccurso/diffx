import type { CommentStore } from './comments.js'
import type { ImportResult, ReviewComment } from './types.js'

export interface ParsedComment {
  scope?: 'file' | 'diff'
  filePath: string
  side: 'additions' | 'deletions'
  lineNumber: number
  startLineNumber?: number
  lineContent: string
  body: string
  status: 'open' | 'resolved'
}

// Exports append `<reply author="...">` blocks after a comment's body. They
// are not imported, and must not leak into the body.
function stripReplies(body: string): string {
  return body.replace(/(?:\n<reply author="[^"]*">\n[\s\S]*?\n<\/reply>)+$/, '')
}

// One `<comment line="N|A-B" [status="resolved"]>` block, parsed from the
// text between its opening and closing tags (excluding the tags themselves).
function parseCommentBlock(filePath: string, lineLabel: string, statusAttr: string | undefined, inner: string): ParsedComment {
  const codeMatch = inner.match(/^<code>([\s\S]*?)<\/code>\n([\s\S]*)$/)
  if (!codeMatch) throw new Error('malformed comment block: missing <code> block')
  const [, code, rawBody] = codeMatch
  const body = stripReplies(rawBody)

  const codeLines = code.split('\n')
  const prefixChar = codeLines[0]?.[0]
  if (prefixChar !== '+' && prefixChar !== '-') {
    throw new Error('malformed comment block: unrecognized code prefix')
  }
  const side: 'additions' | 'deletions' = prefixChar === '+' ? 'additions' : 'deletions'
  // Strip the two-character "+ "/"- " prefix from every code line to recover
  // the original lineContent, preserving a trailing blank line verbatim.
  const lineContent = codeLines.map((line) => line.slice(2)).join('\n')

  let lineNumber: number
  let startLineNumber: number | undefined
  const rangeMatch = lineLabel.match(/^(\d+)-(\d+)$/)
  if (rangeMatch) {
    startLineNumber = parseInt(rangeMatch[1], 10)
    lineNumber = parseInt(rangeMatch[2], 10)
  } else if (/^\d+$/.test(lineLabel)) {
    lineNumber = parseInt(lineLabel, 10)
  } else {
    throw new Error('malformed comment block: unrecognized line label')
  }

  return {
    filePath,
    side,
    lineNumber,
    startLineNumber,
    lineContent,
    body,
    status: statusAttr === 'resolved' ? 'resolved' : 'open',
  }
}

// Parses a "Copy comments" export into structured comments. Text this
// function has already read is never re-parsed downstream.
export function parseCommentExport(text: string): { comments: ParsedComment[]; unreadable: number } {
  if (!text.includes('<code-review-comments>')) {
    return { comments: [], unreadable: 0 }
  }

  const comments: ParsedComment[] = []
  let unreadable = 0

  const scopedRe = /<comment scope="(file|diff)"(?:\s+status="([^"]*)")?>\n([\s\S]*?)\n<\/comment>/g
  const pushScoped = (filePath: string, text: string) => {
    let m: RegExpExecArray | null
    while ((m = scopedRe.exec(text))) {
      comments.push({
        scope: m[1] as 'file' | 'diff',
        filePath,
        side: 'additions',
        lineNumber: 0,
        lineContent: '',
        body: stripReplies(m[3]),
        status: m[2] === 'resolved' ? 'resolved' : 'open',
      })
    }
  }

  // Diff-level comments sit outside any <file> block.
  pushScoped('', text.replace(/<file path="[^"]*">\n[\s\S]*?\n<\/file>/g, ''))

  const fileRe = /<file path="([^"]*)">\n([\s\S]*?)\n<\/file>/g
  let fileMatch: RegExpExecArray | null
  while ((fileMatch = fileRe.exec(text))) {
    const filePath = fileMatch[1]
    const fileBody = fileMatch[2]

    pushScoped(filePath, fileBody)

    const commentRe = /<comment line="([^"]*)"(?:\s+status="([^"]*)")?>\n([\s\S]*?)\n<\/comment>/g
    let commentMatch: RegExpExecArray | null
    while ((commentMatch = commentRe.exec(fileBody))) {
      const [, lineLabel, statusAttr, inner] = commentMatch
      try {
        comments.push(parseCommentBlock(filePath, lineLabel, statusAttr, inner))
      } catch {
        unreadable++
      }
    }
  }

  return { comments, unreadable }
}

function commentAnchorMatches(
  a: { scope?: string; filePath: string; side: string; lineNumber: number; startLineNumber?: number; body: string },
  b: { scope?: string; filePath: string; side: string; lineNumber: number; startLineNumber?: number; body: string },
): boolean {
  return (
    (a.scope ?? 'line') === (b.scope ?? 'line') &&
    a.filePath === b.filePath &&
    a.side === b.side &&
    a.lineNumber === b.lineNumber &&
    a.startLineNumber === b.startLineNumber &&
    a.body.trim() === b.body.trim()
  )
}

// Imports a "Copy comments" export into the given store. A parsed comment is
// a duplicate when its file path, side, line range, and trimmed body match a
// comment already in the store or an earlier comment in the same paste;
// duplicates are skipped and counted.
export async function importComments(store: CommentStore, text: string): Promise<ImportResult> {
  const { comments: parsed, unreadable } = parseCommentExport(text)
  const existing = await store.getAll()
  const seenInPaste: ReviewComment[] = []
  let imported = 0
  let duplicates = 0

  for (const candidate of parsed) {
    const isDuplicate =
      existing.some((c) => commentAnchorMatches(candidate, c)) || seenInPaste.some((c) => commentAnchorMatches(candidate, c))
    if (isDuplicate) {
      duplicates++
      continue
    }
    const created = await store.add({
      id: crypto.randomUUID(),
      ...(candidate.scope ? { scope: candidate.scope } : {}),
      filePath: candidate.filePath,
      side: candidate.side,
      lineNumber: candidate.lineNumber,
      startLineNumber: candidate.startLineNumber,
      lineContent: candidate.lineContent,
      body: candidate.body,
      status: candidate.status,
      createdAt: Date.now(),
      replies: [],
    })
    seenInPaste.push(created)
    imported++
  }

  return { imported, duplicates, unreadable, comments: seenInPaste }
}

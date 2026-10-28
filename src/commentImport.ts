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

const REPLY_OPEN = '\n<reply author="[^"]*">\n'
const REPLY_CLOSE = '\n</reply>'

// Reply blocks trail a comment's body and are not imported. The cut starts at
// the first opening tag that ends before the final close tag.
function stripReplies(body: string): string {
  if (!body.endsWith(REPLY_CLOSE)) return body
  const closeStart = body.length - REPLY_CLOSE.length
  const opening = new RegExp(REPLY_OPEN, 'g')
  let m: RegExpExecArray | null
  while ((m = opening.exec(body)) && m.index < closeStart) {
    if (m.index + m[0].length <= closeStart) return body.slice(0, m.index)
    opening.lastIndex = m.index + 1
  }
  return body
}

interface Block {
  open: RegExpExecArray
  start: number
  end: number
  inner: string
}

// A lazy regex over the whole text backtracks quadratically on unclosed
// openings. Once one opening has no closing tag, no later one has either.
function findBlocks(text: string, openingSource: string, closing: string): Block[] {
  const opening = new RegExp(openingSource, 'g')
  const blocks: Block[] = []
  let m: RegExpExecArray | null
  while ((m = opening.exec(text))) {
    const innerStart = m.index + m[0].length
    const closeAt = text.indexOf(closing, innerStart)
    if (closeAt === -1) break
    const end = closeAt + closing.length
    blocks.push({ open: m, start: m.index, end, inner: text.slice(innerStart, closeAt) })
    opening.lastIndex = end
  }
  return blocks
}

const FILE_OPEN = '<file path="([^"]*)">\n'
const FILE_CLOSE = '\n</file>'
const SCOPED_OPEN = '<comment scope="(file|diff)"(?:\\s+status="([^"]*)")?>\n'
const LINE_OPEN = '<comment line="([^"]*)"(?:\\s+status="([^"]*)")?>\n'
const COMMENT_CLOSE = '\n</comment>'

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

  const pushScoped = (filePath: string, text: string) => {
    for (const block of findBlocks(text, SCOPED_OPEN, COMMENT_CLOSE)) {
      comments.push({
        scope: block.open[1] as 'file' | 'diff',
        filePath,
        side: 'additions',
        lineNumber: 0,
        lineContent: '',
        body: stripReplies(block.inner),
        status: block.open[2] === 'resolved' ? 'resolved' : 'open',
      })
    }
  }

  const fileBlocks = findBlocks(text, FILE_OPEN, FILE_CLOSE)

  // Diff-level comments sit outside any <file> block.
  const outsideFiles: string[] = []
  let position = 0
  for (const block of fileBlocks) {
    outsideFiles.push(text.slice(position, block.start))
    position = block.end
  }
  outsideFiles.push(text.slice(position))
  pushScoped('', outsideFiles.join(''))

  for (const fileBlock of fileBlocks) {
    const filePath = fileBlock.open[1]
    const fileBody = fileBlock.inner

    pushScoped(filePath, fileBody)

    for (const block of findBlocks(fileBody, LINE_OPEN, COMMENT_CLOSE)) {
      const [, lineLabel, statusAttr] = block.open
      try {
        comments.push(parseCommentBlock(filePath, lineLabel, statusAttr, block.inner))
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

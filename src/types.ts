export interface CommentReply {
  id: string
  body: string
  createdAt: number
}

export interface ReviewComment {
  id: string
  // Absent means 'line'. File- and diff-level comments carry no line anchor:
  // side 'additions', lineNumber 0, empty lineContent; diff-level ones also
  // have an empty filePath.
  scope?: 'line' | 'file' | 'diff'
  filePath: string
  side: 'deletions' | 'additions'
  // The last line of the comment's range. For a single-line comment this is
  // the only line; `startLineNumber` is set only when the comment spans more
  // than one line.
  lineNumber: number
  startLineNumber?: number
  lineContent: string
  body: string
  status: 'open' | 'resolved'
  createdAt: number
  editedAt?: number // ms since epoch of the last body edit; absent if the body was never edited
  replies: CommentReply[]
}

// Identifies a review (repo + resolved diff endpoints)
export interface ReviewIdentity {
  repoRoot: string
  args: string[] // the diff arguments, verbatim as the user wrote them
  revisions: string[] // resolved commit SHAs, one per named revision, in argument order
  head?: string // resolved HEAD SHA; present when the diff includes the working tree or the index
}

// The submit state of a review: how many times the reviewer has sent it to
// the agent, and the last round the agent reported as handled.
export interface RoundsState {
  round: number
  submittedAt: number | null
  addressedRound: number
  addressedAt: number | null
}

// The on-disk shape of one review file
export interface ReviewFile {
  version: 1
  identity: ReviewIdentity
  comments: ReviewComment[]
  rounds?: RoundsState
}

// The result of one import
export interface ImportResult {
  imported: number
  duplicates: number
  unreadable: number
  comments: ReviewComment[]
}

// The shape of GET /api/review: whether this session persists comments, and
// (when it does) where they live and how many came back at start.
export interface ReviewMeta {
  persisted: boolean
  file?: string
  identity?: ReviewIdentity
  restoredCount: number
  saveError?: string
}

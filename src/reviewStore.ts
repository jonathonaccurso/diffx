import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CommentReply, ReviewComment, ReviewFile, ReviewIdentity, RoundsState } from './types.js'
import type { CommentStore } from './comments.js'
import { initialRoundsState, parseRoundsState } from './rounds.js'
import type { RoundsStore } from './rounds.js'

function canonicalIdentity(identity: ReviewIdentity): string {
  // Fixed key order regardless of the identity's own construction order, so
  // two identities with the same fields always hash the same.
  return JSON.stringify({
    repoRoot: identity.repoRoot,
    args: identity.args,
    revisions: identity.revisions,
    head: identity.head ?? null,
  })
}

// The stable id for one review: the first 16 hex characters of the SHA-256
// of the identity's canonical JSON. Same shape as settings.ts's
// ~/.config/diffx/settings.json precedent, but one file per review under
// ~/.config/diffx/reviews/<id>.json.
export function reviewIdentityId(identity: ReviewIdentity): string {
  return createHash('sha256').update(canonicalIdentity(identity)).digest('hex').slice(0, 16)
}

// A CommentStore backed by one JSON file per review. Delegates to an
// in-memory array (same shape as InMemoryCommentStore) and persists after
// every mutation: a review with no comments and no submitted round has no
// file on disk. The review rounds state is saved in the same file.
export class FileCommentStore implements CommentStore, RoundsStore {
  private comments: ReviewComment[]
  private rounds: RoundsState

  constructor(
    private readonly file: string,
    private readonly identity: ReviewIdentity,
    initialComments: ReviewComment[],
    initialRounds: RoundsState = initialRoundsState(),
  ) {
    this.comments = initialComments
    this.rounds = initialRounds
  }

  getRounds(): RoundsState {
    return { ...this.rounds }
  }

  setRounds(state: RoundsState): void {
    this.rounds = { ...state }
    this.persist()
  }

  async getAll(): Promise<ReviewComment[]> {
    return this.comments
  }

  async add(comment: ReviewComment): Promise<ReviewComment> {
    this.comments.push(comment)
    this.persist()
    return comment
  }

  async update(
    id: string,
    fields: { body?: string; status?: ReviewComment['status']; editedAt?: number },
  ): Promise<ReviewComment | null> {
    const comment = this.comments.find((c) => c.id === id)
    if (!comment) return null
    if (fields.body !== undefined) comment.body = fields.body
    if (fields.status !== undefined) comment.status = fields.status
    if (fields.editedAt !== undefined) comment.editedAt = fields.editedAt
    this.persist()
    return comment
  }

  async remove(id: string): Promise<boolean> {
    const index = this.comments.findIndex((c) => c.id === id)
    if (index === -1) return false
    this.comments.splice(index, 1)
    this.persist()
    return true
  }

  async addReply(commentId: string, reply: CommentReply): Promise<ReviewComment | null> {
    const comment = this.comments.find((c) => c.id === commentId)
    if (!comment) return null
    comment.replies.push(reply)
    this.persist()
    return comment
  }

  private persist(): void {
    if (this.comments.length === 0 && this.rounds.round === 0) {
      // A review with nothing to save has no file: remove it if a previous
      // mutation created one (e.g. every comment was later deleted).
      try {
        unlinkSync(this.file)
      } catch {
        // already absent
      }
      return
    }
    const contents: ReviewFile = {
      version: 1,
      identity: this.identity,
      comments: this.comments,
      rounds: this.rounds,
    }
    mkdirSync(dirname(this.file), { recursive: true })
    const tmpFile = `${this.file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmpFile, JSON.stringify(contents, null, 2))
    renameSync(tmpFile, this.file)
  }
}

// Opens (or creates) the review file for the given identity under
// reviewsDir. Reads and parses an existing file when present; a missing or
// unparsable file starts empty (restoredCount: 0) rather than throwing, and
// creates no file until the first comment is added or the review is submitted.
export function openReviewStore(
  reviewsDir: string,
  identity: ReviewIdentity,
): { store: FileCommentStore; restoredCount: number; file: string } {
  const file = join(reviewsDir, `${reviewIdentityId(identity)}.json`)
  let comments: ReviewComment[] = []
  let rounds = initialRoundsState()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ReviewFile
    if (Array.isArray(parsed.comments)) comments = parsed.comments
    rounds = parseRoundsState(parsed.rounds)
  } catch {
    comments = []
    rounds = initialRoundsState()
  }
  return { store: new FileCommentStore(file, identity, comments, rounds), restoredCount: comments.length, file }
}

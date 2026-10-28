import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openReviewStore, reviewIdentityId } from '../../src/reviewStore.js'
import { createApp } from '../../src/server.js'
import type { ReviewComment, ReviewIdentity } from '../../src/types.js'

let reviewsDir: string

const identity: ReviewIdentity = {
  repoRoot: '/repo',
  args: ['HEAD~1..HEAD'],
  revisions: ['a'.repeat(40), 'b'.repeat(40)],
}

function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    filePath: 'greet.ts',
    side: 'additions',
    lineNumber: 2,
    lineContent: "  return 'Hi'",
    body: 'a comment',
    status: 'open',
    createdAt: Date.now(),
    replies: [],
    ...overrides,
  }
}

beforeEach(() => {
  reviewsDir = mkdtempSync(join(tmpdir(), 'diffx-review-store-'))
})

afterEach(() => {
  rmSync(reviewsDir, { recursive: true, force: true })
})

describe('FileCommentStore / openReviewStore', () => {
  it('round-trips a comment through a new file', async () => {
    const opened = openReviewStore(reviewsDir, identity)
    await opened.store.add(makeComment())

    const reloaded = openReviewStore(reviewsDir, identity)

    expect(reloaded.restoredCount).toBe(1)
    const comments = await reloaded.store.getAll()
    expect(comments).toHaveLength(1)
    expect(comments[0].body).toBe('a comment')
  })

  it('yields restoredCount 0 and creates no file when nothing has been stored', () => {
    const opened = openReviewStore(reviewsDir, identity)

    expect(opened.restoredCount).toBe(0)
    expect(existsSync(opened.file)).toBe(false)
  })

  it('creates no file after a comment is added and then removed', async () => {
    const opened = openReviewStore(reviewsDir, identity)
    const added = await opened.store.add(makeComment())
    expect(existsSync(opened.file)).toBe(true)

    await opened.store.remove(added.id)

    expect(existsSync(opened.file)).toBe(false)
  })

  it('persists the identity and comments as valid JSON on disk', async () => {
    const opened = openReviewStore(reviewsDir, identity)
    await opened.store.add(makeComment())

    const raw = JSON.parse(readFileSync(opened.file, 'utf-8'))
    expect(raw.version).toBe(1)
    expect(raw.identity).toEqual(identity)
    expect(raw.comments).toHaveLength(1)
  })

  it('hashes two identities that differ only by resolved SHA to different ids', () => {
    const movedIdentity: ReviewIdentity = { ...identity, revisions: ['c'.repeat(40), 'd'.repeat(40)] }

    expect(reviewIdentityId(identity)).not.toBe(reviewIdentityId(movedIdentity))

    // A moved branch opens a new, empty review rather than reusing the old file.
    const opened = openReviewStore(reviewsDir, movedIdentity)
    expect(opened.restoredCount).toBe(0)
  })
})

describe('review rounds in the review file', () => {
  it('starts at the defaults and creates no file', () => {
    const opened = openReviewStore(reviewsDir, identity)

    expect(opened.store.getRounds()).toEqual({ round: 0, submittedAt: null, addressedRound: 0, addressedAt: null })
    expect(existsSync(opened.file)).toBe(false)
  })

  it('saves the rounds next to the comments and restores them', async () => {
    const opened = openReviewStore(reviewsDir, identity)
    await opened.store.add(makeComment())
    opened.store.setRounds({ round: 2, submittedAt: 1000, addressedRound: 1, addressedAt: 900 })

    const raw = JSON.parse(readFileSync(opened.file, 'utf-8'))
    expect(raw.comments).toHaveLength(1)
    expect(raw.rounds).toEqual({ round: 2, submittedAt: 1000, addressedRound: 1, addressedAt: 900 })

    const reloaded = openReviewStore(reviewsDir, identity)
    expect(reloaded.store.getRounds()).toEqual(raw.rounds)
    expect(reloaded.restoredCount).toBe(1)
  })

  it('keeps the file for a submitted review that has no comments', () => {
    const opened = openReviewStore(reviewsDir, identity)
    opened.store.setRounds({ round: 1, submittedAt: 1000, addressedRound: 0, addressedAt: null })

    expect(existsSync(opened.file)).toBe(true)
    expect(openReviewStore(reviewsDir, identity).store.getRounds().round).toBe(1)
  })

  it('keeps the rounds when the last comment is removed', async () => {
    const opened = openReviewStore(reviewsDir, identity)
    const added = await opened.store.add(makeComment())
    opened.store.setRounds({ round: 1, submittedAt: 1000, addressedRound: 0, addressedAt: null })

    await opened.store.remove(added.id)

    expect(openReviewStore(reviewsDir, identity).store.getRounds().round).toBe(1)
  })

  it('starts at the defaults for a file written without rounds', () => {
    const opened = openReviewStore(reviewsDir, identity)
    writeFileSync(opened.file, JSON.stringify({ version: 1, identity, comments: [makeComment()] }))

    const reloaded = openReviewStore(reviewsDir, identity)

    expect(reloaded.restoredCount).toBe(1)
    expect(reloaded.store.getRounds()).toEqual({ round: 0, submittedAt: null, addressedRound: 0, addressedAt: null })
  })

  it('falls back to the defaults for a malformed rounds field', () => {
    const opened = openReviewStore(reviewsDir, identity)
    writeFileSync(
      opened.file,
      JSON.stringify({ version: 1, identity, comments: [], rounds: { round: 'x', addressedRound: 5 } }),
    )

    expect(openReviewStore(reviewsDir, identity).store.getRounds().round).toBe(0)
  })

  it('serves the stored rounds through the app and saves a submit', async () => {
    const opened = openReviewStore(reviewsDir, identity)
    const app = createApp({
      clientDir: reviewsDir,
      commentStore: opened.store,
      roundsStore: opened.store,
    })

    await app.request('/api/rounds/submit', { method: 'POST' })

    const reloaded = openReviewStore(reviewsDir, identity)
    expect(reloaded.store.getRounds().round).toBe(1)
    const res = await createApp({ clientDir: reviewsDir, roundsStore: reloaded.store }).request('/api/rounds')
    expect((await res.json()).round).toBe(1)
  })
})

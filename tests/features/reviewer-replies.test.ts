// Feature: the reviewer replies inside a thread and every reply carries its author.
//
// Given a comment the agent has answered,
// When the reviewer replies and the review is persisted and reloaded,
// Then the thread keeps both replies with their authors, waits for the agent,
// And the exported comments name each reply's author.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server.js'
import { openReviewStore } from '../../src/reviewStore.js'
import { formatComments } from '../../src/commentFormat.js'
import { threadState } from '../../src/threadState.js'
import type { ReviewComment, ReviewIdentity } from '../../src/types.js'

const identity: ReviewIdentity = { repoRoot: '/repo', args: ['HEAD~1..HEAD'], revisions: ['a'.repeat(40), 'b'.repeat(40)] }
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffx-replies-'))
  dirs.push(dir)
  return dir
}

async function json(app: ReturnType<typeof createApp>, method: string, path: string, payload?: object) {
  const res = await app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  })
  return { status: res.status, body: await res.json() }
}

describe('reviewer replies', () => {
  it('keeps authors through persistence and moves the thread between agent and reviewer', async () => {
    const reviewsDir = tempDir()
    const { store } = openReviewStore(reviewsDir, identity)
    const app = createApp({ clientDir: tempDir(), commentStore: store })

    const created = (
      await json(app, 'POST', '/api/comments', {
        filePath: 'greet.ts',
        side: 'additions',
        lineNumber: 2,
        lineContent: 'x',
        body: 'Rename this',
      })
    ).body as ReviewComment
    expect(threadState(created)).toBe('waiting-agent')

    const answered = await json(app, 'POST', `/api/comments/${created.id}/replies`, { body: 'Renamed.' })
    expect(threadState(answered.body)).toBe('waiting-reviewer')

    const followUp = await json(app, 'POST', `/api/comments/${created.id}/replies`, {
      body: 'Also rename the test.',
      author: 'reviewer',
    })
    expect(threadState(followUp.body)).toBe('waiting-agent')

    const reloaded = await openReviewStore(reviewsDir, identity).store.getAll()
    expect(reloaded[0].replies.map((r) => r.author)).toEqual([undefined, 'reviewer'])

    const text = formatComments(reloaded)
    expect(text.indexOf('<reply author="agent">')).toBeLessThan(text.indexOf('<reply author="reviewer">'))
  })

  it('refuses an unknown author and leaves the thread as it was', async () => {
    const app = createApp({ clientDir: tempDir() })
    const created = (
      await json(app, 'POST', '/api/comments', { scope: 'diff', body: 'Add a changeset' })
    ).body as ReviewComment

    const res = await json(app, 'POST', `/api/comments/${created.id}/replies`, { body: 'hi', author: 'user' })

    expect(res.status).toBe(400)
    const all = (await json(app, 'GET', '/api/comments')).body as ReviewComment[]
    expect(all[0].replies).toEqual([])
  })
})

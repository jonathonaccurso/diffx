import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/server.js'
import { InMemoryCommentStore } from '../../src/comments.js'
import { importComments } from '../../src/commentImport.js'
import { formatComments } from '../../src/commentFormat.js'
import type { ReviewComment } from '../../src/types.js'

async function post(app: ReturnType<typeof createApp>, payload: object): Promise<ReviewComment> {
  const res = await app.request('/api/comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  expect(res.status).toBe(201)
  return res.json()
}

describe('file- and diff-level comments', () => {
  it('creates, exports, and re-imports scoped comments', async () => {
    const app = createApp({ clientDir: mkdtempSync(join(tmpdir(), 'diffx-scoped-')) })
    const file = await post(app, { scope: 'file', filePath: 'greet.ts', body: 'Split this file.' })
    const diff = await post(app, { scope: 'diff', body: 'Add a changeset.' })
    const line = await post(app, { filePath: 'greet.ts', side: 'additions', lineNumber: 2, lineContent: 'x', body: 'Line note' })

    expect(file.scope).toBe('file')
    expect(file.filePath).toBe('greet.ts')
    expect(diff.scope).toBe('diff')
    expect(diff.filePath).toBe('')
    expect(line.scope ?? 'line').toBe('line')

    const all: ReviewComment[] = await (await app.request('/api/comments')).json()
    const text = formatComments(all)
    expect(text).toContain('<comment scope="diff">')
    expect(text).toContain('<comment scope="file">')

    const store = new InMemoryCommentStore()
    const result = await importComments(store, text)
    expect(result.imported).toBe(3)
    const restored = await store.getAll()
    expect(restored.find((c) => c.scope === 'file')?.body).toBe('Split this file.')
    expect(restored.find((c) => c.scope === 'diff')?.filePath).toBe('')

    const again = await importComments(store, text)
    expect(again.imported).toBe(0)
    expect(again.duplicates).toBe(3)
  })

  it('rejects a file-scope comment without a file path', async () => {
    const app = createApp({ clientDir: mkdtempSync(join(tmpdir(), 'diffx-scoped-')) })
    const res = await app.request('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'file', body: 'x' }),
    })
    expect(res.status).toBe(400)
  })
})

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/server.js'

function fixtureClientDir(): string {
  return mkdtempSync(join(tmpdir(), 'diffx-server-import-'))
}

describe('POST /api/comments/import', () => {
  it('imports comments from a pasted export', async () => {
    const app = createApp({ clientDir: fixtureClientDir() })
    const text = [
      '<code-review-comments>',
      '<file path="greet.ts">',
      '<comment line="2">',
      '<code>+ line</code>',
      'a comment',
      '</comment>',
      '</file>',
      '</code-review-comments>',
    ].join('\n')

    const res = await app.request('/api/comments/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })

    expect(res.status).toBe(200)
    const result = await res.json()
    expect(result).toMatchObject({ imported: 1, duplicates: 0, unreadable: 0 })
    expect(result.comments).toHaveLength(1)
  })

  it('rejects text over 1MB with 413 before parsing', async () => {
    const app = createApp({ clientDir: fixtureClientDir() })
    const oversized = 'x'.repeat(1_000_001)

    const res = await app.request('/api/comments/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: oversized }),
    })

    expect(res.status).toBe(413)
  })

  function streamOf(text: string, chunkSize: number): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text)
    let offset = 0
    return new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close()
          return
        }
        controller.enqueue(bytes.slice(offset, offset + chunkSize))
        offset += chunkSize
      },
    })
  }

  it('rejects an oversized streamed body that has no content-length header', async () => {
    const app = createApp({ clientDir: fixtureClientDir() })
    const body = JSON.stringify({ text: 'x'.repeat(1_000_001) })

    const res = await app.request('/api/comments/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: streamOf(body, 64 * 1024),
      duplex: 'half',
    } as RequestInit)

    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'Import text is too large' })
  })

  it('accepts a streamed body of exactly the limit', async () => {
    const app = createApp({ clientDir: fixtureClientDir() })
    const envelope = JSON.stringify({ text: '' })
    const body = JSON.stringify({ text: 'x'.repeat(1_000_000 - envelope.length) })
    expect(new TextEncoder().encode(body).length).toBe(1_000_000)

    const res = await app.request('/api/comments/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: streamOf(body, 64 * 1024),
      duplex: 'half',
    } as RequestInit)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ imported: 0, duplicates: 0, unreadable: 0 })
  })

  it('rejects a body over the limit that declares its content-length', async () => {
    const app = createApp({ clientDir: fixtureClientDir() })

    const res = await app.request('/api/comments/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(1_000_001) }),
    })

    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'Import text is too large' })
  })
})

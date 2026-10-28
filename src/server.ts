import { readFile } from 'node:fs/promises'
import { join, extname, resolve } from 'node:path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { getGitDiff, getCustomGitDiff, getRepoName, getBranchName, getFileContent, getBlobContent, getWorktreeFileContent, isImageFile, getTabSizeForFiles, getUntrackedFilePaths } from './git.js'
import { loadSettings, saveSettings } from './settings.js'
import { InMemoryCommentStore } from './comments.js'
import type { CommentStore } from './comments.js'
import { importComments } from './commentImport.js'
import { InMemoryRoundsStore, ReviewRounds, parseAfter, parseWaitTimeout } from './rounds.js'
import type { RoundsStore } from './rounds.js'
import { isSafePath } from './path.js'
import type { CommentReply, ReviewComment, ReviewMeta } from './types.js'

const MAX_IMPORT_BYTES = 1_000_000

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

export interface BinaryFileInfo {
  path: string
  type: 'added' | 'deleted' | 'changed' | 'untracked'
}

function parseFilePaths(patch: string): string[] {
  const paths = new Set<string>()
  for (const line of patch.split('\n')) {
    const match = line.match(/^diff --git a\/.+ b\/(.+)$/)
    if (match) paths.add(match[1])
  }
  return [...paths]
}

function parseBinaryFiles(patch: string, untrackedFiles?: Set<string>): BinaryFileInfo[] {
  const binaryFiles: BinaryFileInfo[] = []
  const lines = patch.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('Binary files ') || !line.includes(' differ')) continue

    // Find the file path from the preceding diff --git line
    let filePath = ''
    for (let j = i - 1; j >= 0; j--) {
      const match = lines[j].match(/^diff --git a\/.+ b\/(.+)$/)
      if (match) {
        filePath = match[1]
        break
      }
    }
    if (!filePath) continue

    // Determine change type from surrounding lines
    let changeType: BinaryFileInfo['type'] = 'changed'
    for (let j = i - 1; j >= 0; j--) {
      if (lines[j].startsWith('diff --git')) break
      if (lines[j].startsWith('new file mode')) {
        changeType = 'added'
        break
      }
      if (lines[j].startsWith('deleted file mode')) {
        changeType = 'deleted'
        break
      }
    }

    if (changeType === 'added' && untrackedFiles?.has(filePath)) {
      changeType = 'untracked'
    }
    binaryFiles.push({ path: filePath, type: changeType })
  }
  return binaryFiles
}

function diffContainsFileVersion(patch: string, path: string, oldOid: string, newOid: string): boolean {
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    // Match the new-file path from the `+++ b/<path>` header (as the client
    // does); the `diff --git` line is ambiguous for paths containing ` b/`.
    const nameMatch = chunk.match(/^\+\+\+ [ab]\/([^\t\r\n]+)/m)
    if (!nameMatch || nameMatch[1].trim() !== path) continue
    const indexMatch = chunk.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)/m)
    if (indexMatch && indexMatch[1] === oldOid && indexMatch[2] === newOid) return true
  }
  return false
}

export interface CreateAppOptions {
  clientDir: string
  customDiffArgs?: string[]
  commentStore?: CommentStore
  roundsStore?: RoundsStore
  reviewMeta?: ReviewMeta
}

export function createApp(options: CreateAppOptions) {
  const { clientDir, customDiffArgs, commentStore, roundsStore, reviewMeta } = options
  const app = new Hono()
  const isCustomMode = !!customDiffArgs
  const store = commentStore ?? new InMemoryCommentStore()
  const rounds = new ReviewRounds(roundsStore ?? new InMemoryRoundsStore())
  const meta: ReviewMeta = reviewMeta ?? { persisted: false, restoredCount: 0 }
  const viewedFiles = new Map<string, string>()

  app.get('/api/diff', (c) => {
    let patch: string
    const staged = c.req.query('staged') === 'true'
    const untracked = c.req.query('untracked') === 'true'
    if (isCustomMode) {
      patch = getCustomGitDiff(customDiffArgs)
    } else {
      patch = getGitDiff({ staged, untracked })
    }
    const repoName = getRepoName()
    const branch = getBranchName()
    const untrackedFiles = untracked ? getUntrackedFilePaths() : []
    const untrackedSet = new Set(untrackedFiles)
    const binaryFiles = parseBinaryFiles(patch, untrackedSet)
    const filePaths = parseFilePaths(patch)
    const tabSizeMap = getTabSizeForFiles(filePaths)
    return c.json({ patch, repoName, branch, customMode: isCustomMode, binaryFiles, tabSizeMap, untrackedFiles })
  })

  app.get('/api/file-content', (c) => {
    const path = c.req.query('path')
    const version = c.req.query('version') as 'old' | 'new'
    if (!path || !version) {
      return c.json({ error: 'Missing path or version' }, 400)
    }
    const content = getFileContent(path, version)
    if (!content) {
      return c.json({ error: 'File not found' }, 404)
    }
    const ext = extname(path)
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'
    return new Response(new Uint8Array(content), {
      headers: { 'Content-Type': contentType },
    })
  })

  // Full old/new file contents for a diffed file, so the client can build a
  // non-partial diff that supports expanding context around hunks.
  // `oldOid`/`newOid` are blob ids from the patch's `index` line. The diff is
  // regenerated and the requested oids must match its `index` line for the
  // requested path: this keeps arbitrary repository blobs unreachable, and
  // rejects requests whose patch no longer matches the worktree (git recomputes
  // the worktree blob hash on every diff, so any edit changes the new oid).
  app.get('/api/file-versions', (c) => {
    const path = c.req.query('path')
    const oldOid = c.req.query('oldOid')
    const newOid = c.req.query('newOid')
    if (!path || !oldOid || !newOid) {
      return c.json({ error: 'Missing path or oids' }, 400)
    }
    const staged = c.req.query('staged') === 'true'
    const untracked = c.req.query('untracked') === 'true'
    const patch = isCustomMode ? getCustomGitDiff(customDiffArgs) : getGitDiff({ staged, untracked })
    if (!diffContainsFileVersion(patch, path, oldOid, newOid)) {
      return c.json({ error: 'File version not in current diff' }, 404)
    }
    // A zero oid is git's `/dev/null` — an absent side (creation/deletion), so
    // its content is empty. A non-zero oid that is missing from the object
    // database is the worktree blob of an unstaged change (git computes its
    // hash without storing it), so fall back to reading the worktree.
    const oldContent = /^0+$/.test(oldOid) ? '' : getBlobContent(oldOid)
    const newContent = /^0+$/.test(newOid) ? '' : getBlobContent(newOid) ?? getWorktreeFileContent(path)
    if (oldContent == null || newContent == null) {
      return c.json({ error: 'Content unavailable' }, 404)
    }
    return c.json({ old: oldContent, new: newContent })
  })

  app.get('/api/settings', (c) => {
    return c.json(loadSettings())
  })

  app.put('/api/settings', async (c) => {
    const body = await c.req.json()
    const settings = saveSettings(body)
    return c.json(settings)
  })

  app.get('/api/viewed', (c) => {
    return c.json(Object.fromEntries(viewedFiles))
  })

  app.put('/api/viewed', async (c) => {
    const { filePath, viewed, contentHash } = await c.req.json<{ filePath: string; viewed: boolean; contentHash?: string }>()
    if (viewed) {
      if (typeof contentHash !== 'string' || contentHash.length === 0) {
        return c.json({ error: 'non-empty contentHash required when marking viewed' }, 400)
      }
      viewedFiles.set(filePath, contentHash)
    } else {
      viewedFiles.delete(filePath)
    }
    return c.json({ ok: true })
  })

  app.get('/api/review', (c) => {
    return c.json(meta)
  })

  app.get('/api/rounds', (c) => {
    return c.json(rounds.get())
  })

  app.post('/api/rounds/submit', (c) => {
    return c.json(rounds.submit())
  })

  app.get('/api/rounds/wait', async (c) => {
    const after = parseAfter(c.req.query('after'))
    const timeout = parseWaitTimeout(c.req.query('timeout'))
    return c.json(await rounds.wait(after, timeout, c.req.raw.signal))
  })

  app.post('/api/rounds/addressed', async (c) => {
    const body = await c.req.json().catch(() => null)
    const round = body?.round
    if (typeof round !== 'number' || !Number.isInteger(round) || round < 0) {
      return c.json({ error: 'round must be a non-negative integer' }, 400)
    }
    const state = rounds.markAddressed(round)
    if (!state) return c.json({ error: 'round is above the current round' }, 400)
    return c.json(state)
  })

  app.get('/api/comments', async (c) => {
    const comments = await store.getAll()
    return c.json(comments)
  })

  app.post('/api/comments', async (c) => {
    const body = await c.req.json()
    const scope: 'line' | 'file' | 'diff' = body.scope === 'file' || body.scope === 'diff' ? body.scope : 'line'
    if (scope === 'file' && (typeof body.filePath !== 'string' || body.filePath === '')) {
      return c.json({ error: 'File comment requires a filePath' }, 400)
    }
    const anchor =
      scope === 'line'
        ? {
            filePath: body.filePath,
            side: body.side,
            lineNumber: body.lineNumber,
            startLineNumber: body.startLineNumber,
            lineContent: body.lineContent,
          }
        : {
            scope,
            filePath: scope === 'file' ? (body.filePath as string) : '',
            side: 'additions' as const,
            lineNumber: 0,
            lineContent: '',
          }
    const comment = {
      id: crypto.randomUUID(),
      ...anchor,
      body: body.body,
      status: 'open' as const,
      createdAt: Date.now(),
      replies: [],
    }
    const created = await store.add(comment)
    return c.json(created, 201)
  })

  app.put('/api/comments/:id', async (c) => {
    const id = c.req.param('id')
    const { body, status } = await c.req.json()
    if (body !== undefined && (typeof body !== 'string' || body.trim() === '')) {
      return c.json({ error: 'Comment body must be a non-empty string' }, 400)
    }
    const existing = (await store.getAll()).find((comment) => comment.id === id)
    if (!existing) return c.json({ error: 'Comment not found' }, 404)
    const fields: { body?: string; status?: ReviewComment['status']; editedAt?: number } = { status }
    if (body !== undefined && body !== existing.body) {
      fields.body = body
      fields.editedAt = Date.now()
    }
    const updated = await store.update(id, fields)
    if (!updated) return c.json({ error: 'Comment not found' }, 404)
    return c.json(updated)
  })

  app.post('/api/comments/import', async (c) => {
    const contentLength = Number(c.req.header('content-length') ?? 0)
    if (contentLength > MAX_IMPORT_BYTES) {
      return c.json({ error: 'Import text is too large' }, 413)
    }
    const { text } = await c.req.json<{ text: string }>()
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf-8') > MAX_IMPORT_BYTES) {
      return c.json({ error: 'Import text is too large' }, 413)
    }
    const result = await importComments(store, text)
    return c.json(result)
  })

  app.post('/api/comments/:id/replies', async (c) => {
    const commentId = c.req.param('id')
    const { body, author } = await c.req.json()
    if (author !== undefined && author !== 'reviewer' && author !== 'agent') {
      return c.json({ error: "Reply author must be 'reviewer' or 'agent'" }, 400)
    }
    const reply: CommentReply = {
      id: crypto.randomUUID(),
      body,
      createdAt: Date.now(),
      ...(author ? { author } : {}),
    }
    const updated = await store.addReply(commentId, reply)
    if (!updated) return c.json({ error: 'Comment not found' }, 404)
    return c.json(updated)
  })

  app.delete('/api/comments/:id', async (c) => {
    const id = c.req.param('id')
    const removed = await store.remove(id)
    if (!removed) return c.json({ error: 'Comment not found' }, 404)
    return c.json({ ok: true })
  })

  app.get('/*', async (c) => {
    let filePath = c.req.path
    if (filePath === '/') filePath = '/index.html'

    const relativePath = filePath.slice(1)
    if (!isSafePath(relativePath, clientDir)) {
      return c.text('Forbidden', 403)
    }
    const fullPath = resolve(clientDir, relativePath)
    try {
      const content = await readFile(fullPath)
      const ext = extname(fullPath)
      const contentType = MIME_TYPES[ext] || 'application/octet-stream'
      return new Response(content, {
        headers: { 'Content-Type': contentType },
      })
    } catch {
      const indexContent = await readFile(join(clientDir, 'index.html'))
      return new Response(indexContent, {
        headers: { 'Content-Type': 'text/html' },
      })
    }
  })

  return app
}

export function startServer(options: {
  port: number
  host: string
  clientDir: string
  customDiffArgs?: string[]
  commentStore?: CommentStore
  roundsStore?: RoundsStore
  reviewMeta?: ReviewMeta
}): Promise<{ port: number }> {
  const app = createApp(options)

  return new Promise((resolve) => {
    const server = serve({
      fetch: app.fetch,
      port: options.port,
      hostname: options.host,
    }, (info) => {
      resolve({ port: info.port })
    })
  })
}

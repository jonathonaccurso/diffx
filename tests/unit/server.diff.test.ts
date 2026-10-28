import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server.js'

let repoDir: string
let originalCwd: string

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repoDir,
    stdio: 'pipe',
  })
}

const write = (name: string, content: string) => writeFileSync(join(repoDir, name), content)

function newApp(customDiffArgs?: string[]) {
  return createApp({ clientDir: mkdtempSync(join(tmpdir(), 'diffx-server-diff-')), customDiffArgs })
}

async function fingerprintOf(app: ReturnType<typeof newApp>, query = '') {
  const res = await app.request(`/api/diff/fingerprint${query}`)
  expect(res.status).toBe(200)
  return (await res.json()).fingerprint as string
}

async function diffOf(app: ReturnType<typeof newApp>, query = '') {
  const res = await app.request(`/api/diff${query}`)
  expect(res.status).toBe(200)
  return res.json()
}

beforeEach(() => {
  originalCwd = process.cwd()
  repoDir = mkdtempSync(join(tmpdir(), 'diffx-diff-test-'))
  git('init', '-q', '-b', 'main')
  write('a.txt', 'one\ntwo\n')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  write('a.txt', 'one\nTWO\n')
  process.chdir(repoDir)
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(repoDir, { recursive: true, force: true })
})

describe('GET /api/diff/fingerprint', () => {
  it('equals the sha256 hex of the patch and the fingerprint field of /api/diff', async () => {
    const app = newApp()
    const diff = await diffOf(app)

    expect(diff.fingerprint).toBe(createHash('sha256').update(diff.patch).digest('hex'))
    expect(await fingerprintOf(app)).toBe(diff.fingerprint)
  })

  it('stays the same while nothing changes', async () => {
    const app = newApp()

    expect(await fingerprintOf(app)).toBe(await fingerprintOf(app))
  })

  it('changes when a tracked file changes', async () => {
    const app = newApp()
    const before = await fingerprintOf(app)

    write('a.txt', 'one\nTWO\nthree\n')

    const after = await fingerprintOf(app)
    expect(after).not.toBe(before)
    expect(after).toBe((await diffOf(app)).fingerprint)
  })

  it('changes for an untracked file only when untracked=true', async () => {
    const app = newApp()
    const untrackedOff = await fingerprintOf(app, '?untracked=false')
    const withOn = await fingerprintOf(app, '?untracked=true')
    write('new.txt', 'fresh\n')

    expect(await fingerprintOf(app, '?untracked=false')).toBe(untrackedOff)
    const withOnAfter = await fingerprintOf(app, '?untracked=true')
    expect(withOnAfter).not.toBe(withOn)

    write('new.txt', 'fresher\n')
    expect(await fingerprintOf(app, '?untracked=true')).not.toBe(withOnAfter)
    expect(await fingerprintOf(app, '?untracked=true')).toBe((await diffOf(app, '?untracked=true')).fingerprint)
  })

  it('honors staged=true', async () => {
    const app = newApp()
    git('add', 'a.txt')
    write('a.txt', 'one\nTWO\nextra\n')
    const unstagedOnly = await fingerprintOf(app, '?staged=false')
    const withStaged = await fingerprintOf(app, '?staged=true')

    expect(withStaged).not.toBe(unstagedOnly)
    expect(withStaged).toBe((await diffOf(app, '?staged=true')).fingerprint)
  })

  it('follows the custom diff arguments', async () => {
    git('commit', '-q', '-am', 'second')
    const app = newApp(['HEAD~1..HEAD'])
    const diff = await diffOf(app)

    expect(diff.customMode).toBe(true)
    expect(await fingerprintOf(app)).toBe(diff.fingerprint)
    expect(await fingerprintOf(app, '?untracked=true&staged=true')).toBe(diff.fingerprint)
  })
})

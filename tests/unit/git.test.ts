import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getFileContent, getGitDiff, getWorktreeFileContent, resolveReviewIdentity } from '../../src/git.js'

const SHA_REGEX = /^[0-9a-f]{40}$/

let repoDir: string
let originalCwd: string

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repoDir,
    stdio: 'pipe',
  })
}

describe('resolveReviewIdentity', () => {
  beforeAll(() => {
    originalCwd = process.cwd()
    repoDir = mkdtempSync(join(tmpdir(), 'diffx-git-test-'))
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repoDir, 'a.txt'), 'one\n')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    writeFileSync(join(repoDir, 'a.txt'), 'two\n')
    git('add', '.')
    git('commit', '-q', '-m', 'head')
    process.chdir(repoDir)
  })

  afterAll(() => {
    process.chdir(originalCwd)
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('resolves a two-revision range to its commit SHAs, with no head', () => {
    const identity = resolveReviewIdentity(['HEAD~1..HEAD'])

    expect(identity.revisions).toHaveLength(2)
    for (const rev of identity.revisions) {
      expect(rev).toMatch(SHA_REGEX)
    }
    expect(identity.head).toBeUndefined()
  })

  it('carries head for a no-argument (working-tree) identity', () => {
    const identity = resolveReviewIdentity(undefined)

    expect(identity.revisions).toHaveLength(0)
    expect(identity.head).toMatch(SHA_REGEX)
  })

  it('carries head for a single-revision identity', () => {
    const identity = resolveReviewIdentity(['HEAD~1'])

    expect(identity.revisions).toHaveLength(1)
    expect(identity.revisions[0]).toMatch(SHA_REGEX)
    expect(identity.head).toMatch(SHA_REGEX)
  })

  it('resolves the same named revision to a different SHA after the branch moves', () => {
    const before = resolveReviewIdentity(['main'])
    writeFileSync(join(repoDir, 'a.txt'), 'three\n')
    git('add', '.')
    git('commit', '-q', '-m', 'moved')
    const after = resolveReviewIdentity(['main'])

    expect(before.revisions[0]).not.toEqual(after.revisions[0])
  })
})

describe('worktree reads never follow symlinks', () => {
  let outsideDir: string
  const secret = 'TOP SECRET CONTENT\n'

  beforeAll(() => {
    originalCwd = process.cwd()
    outsideDir = mkdtempSync(join(tmpdir(), 'diffx-outside-'))
    writeFileSync(join(outsideDir, 'secret.txt'), secret)
    mkdirSync(join(outsideDir, 'dir'))
    writeFileSync(join(outsideDir, 'dir', 'inner.txt'), secret)

    repoDir = mkdtempSync(join(tmpdir(), 'diffx-symlink-test-'))
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repoDir, 'tracked.txt'), 'tracked\n')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    writeFileSync(join(repoDir, 'plain.txt'), 'plain\nfile\n')
    writeFileSync(join(repoDir, 'bin.dat'), Buffer.from([1, 0, 2]))
    symlinkSync(join(outsideDir, 'secret.txt'), join(repoDir, 'notes'))
    symlinkSync(join(outsideDir, 'dir'), join(repoDir, 'linkdir'))
    symlinkSync('tracked.txt', join(repoDir, 'inner-link'))
    mkdirSync(join(repoDir, 'subdir'))
    execFileSync('mkfifo', [join(repoDir, 'pipe')])
    symlinkSync(join(repoDir, 'pipe'), join(repoDir, 'pipe-link'))
    process.chdir(repoDir)
  })

  afterAll(() => {
    process.chdir(originalCwd)
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  it('returns the link text for a symlink that points outside the repo', () => {
    expect(getFileContent('notes', 'new')?.toString()).toBe(join(outsideDir, 'secret.txt'))
    expect(getWorktreeFileContent('notes')).toBe(join(outsideDir, 'secret.txt'))
  })

  it('returns the link text for a symlink that points inside the repo', () => {
    expect(getFileContent('inner-link', 'new')?.toString()).toBe('tracked.txt')
  })

  it('returns null for a file reached through a symlinked parent directory that points outside', () => {
    expect(getFileContent('linkdir/inner.txt', 'new')).toBeNull()
    expect(getWorktreeFileContent('linkdir/inner.txt')).toBeNull()
  })

  it('returns null for a FIFO and a directory without opening them', () => {
    expect(getFileContent('pipe', 'new')).toBeNull()
    expect(getWorktreeFileContent('pipe')).toBeNull()
    expect(getFileContent('subdir', 'new')).toBeNull()
  })

  it('reads regular files as before', () => {
    expect(getFileContent('tracked.txt', 'new')?.toString()).toBe('tracked\n')
    expect(getWorktreeFileContent('plain.txt')).toBe('plain\nfile\n')
    expect(getFileContent('missing.txt', 'new')).toBeNull()
  })

  it('shows an untracked symlink the way git shows a new symlink, with no target content', () => {
    const patch = getGitDiff({ untracked: true })

    expect(patch).toContain(
      [
        'diff --git a/notes b/notes',
        'new file mode 120000',
        'index 0000000..0000001',
        '--- /dev/null',
        '+++ b/notes',
        '@@ -0,0 +1 @@',
        `+${join(outsideDir, 'secret.txt')}`,
        '\\ No newline at end of file',
      ].join('\n'),
    )
    expect(patch).not.toContain('TOP SECRET')
  })

  it('lists a symlink to a FIFO as a symlink and returns without blocking on the FIFO', () => {
    const patch = getGitDiff({ untracked: true })

    expect(patch).toContain(`+${join(repoDir, 'pipe')}\n\\ No newline at end of file`)
    expect(patch).not.toContain('diff --git a/pipe b/pipe')
  })

  it('keeps patching regular untracked files', () => {
    const patch = getGitDiff({ untracked: true })

    expect(patch).toContain('diff --git a/plain.txt b/plain.txt\nnew file mode 100644')
    expect(patch).toContain('+plain\n+file')
    expect(patch).toContain('Binary files /dev/null and b/bin.dat differ')
  })
})

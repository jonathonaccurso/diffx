import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { isSafePath } from './path.js'
import { parseSync as parseEditorConfig, type ProcessedFileConfig } from 'editorconfig'
import type { ReviewIdentity } from './types.js'

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif',
])

export function isImageFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

type WorktreeEntry = { type: 'symlink'; target: string } | { type: 'file'; content: Buffer }

// Git records a symlink as its link text. Other non-regular entries are never
// opened, since a FIFO would block the server; they and escaping paths give null.
function readWorktreeEntry(root: string, relativePath: string): WorktreeEntry | null {
  try {
    const absolute = resolve(root, relativePath)
    const realRoot = realpathSync(root)
    const realParent = realpathSync(dirname(absolute))
    if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
      return null
    }
    const stats = lstatSync(absolute)
    if (stats.isSymbolicLink()) {
      return { type: 'symlink', target: readlinkSync(absolute, 'utf-8') }
    }
    if (!stats.isFile()) {
      return null
    }
    // The entry can be swapped for a FIFO or link after the lstat. O_NONBLOCK
    // and O_NOFOLLOW keep the open from blocking, and the fstat re-checks the type.
    const fd = openSync(absolute, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      if (!fstatSync(fd).isFile()) return null
      return { type: 'file', content: readFileSync(fd) }
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

function isBinaryContent(buffer: Buffer): boolean {
  const bytesToCheck = Math.min(buffer.length, 8192)
  for (let i = 0; i < bytesToCheck; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

export function getFileContent(filePath: string, version: 'old' | 'new'): Buffer | null {
  const root = getRepoRoot()
  if (!isSafePath(filePath, root)) {
    return null
  }
  if (version === 'new') {
    const entry = readWorktreeEntry(root, filePath)
    if (!entry) return null
    return entry.type === 'symlink' ? Buffer.from(entry.target, 'utf-8') : entry.content
  }
  // old version: try staged first, then HEAD
  try {
    return execFileSync('git', ['show', `HEAD:${filePath}`], { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 })
  } catch {
    return null
  }
}

const BLOB_OID_REGEX = /^[0-9a-f]{4,64}$/

export function getBlobContent(oid: string): string | null {
  if (!BLOB_OID_REGEX.test(oid) || /^0+$/.test(oid)) {
    return null
  }
  try {
    return execFileSync('git', ['cat-file', 'blob', oid], { encoding: 'utf-8', stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 })
  } catch {
    return null
  }
}

export function getWorktreeFileContent(filePath: string): string | null {
  const root = getRepoRoot()
  if (!isSafePath(filePath, root)) {
    return null
  }
  const entry = readWorktreeEntry(root, filePath)
  if (!entry) return null
  return entry.type === 'symlink' ? entry.target : entry.content.toString('utf-8')
}

export function isGitRepo(): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export function getRepoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
  }).trim()
}

export function getRepoName(): string {
  return basename(getRepoRoot())
}

export function getBranchName(): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe', encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

// Force standard unified diff regardless of user's git config
// (e.g. diff.external = difftastic, color.ui = always).
const DIFF_FLAGS = ['--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'] as const

export function getCustomGitDiff(args: string[]): string {
  return execFileSync('git', ['diff', ...DIFF_FLAGS, ...args], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 })
}

export function getGitDiff(options: { staged?: boolean; untracked?: boolean } = {}): string {
  const parts: string[] = []

  // unstaged changes (always included as the base)
  const unstaged = execFileSync('git', ['diff', ...DIFF_FLAGS], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 })
  if (unstaged) parts.push(unstaged)

  // staged changes
  if (options.staged) {
    const staged = execFileSync('git', ['diff', ...DIFF_FLAGS, '--staged'], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 })
    if (staged) parts.push(staged)
  }

  // untracked files
  if (options.untracked) {
    const untrackedPatch = getUntrackedFilesDiff()
    if (untrackedPatch) parts.push(untrackedPatch)
  }

  return parts.join('\n')
}

export function getTabSizeForFiles(filePaths: string[]): Record<string, number> {
  const root = getRepoRoot()
  const cache = new Map<string, ProcessedFileConfig>()
  const result: Record<string, number> = {}
  for (const filePath of filePaths) {
    try {
      const absPath = join(root, filePath)
      const config = parseEditorConfig(absPath, { cache })
      const size = config.tab_width ?? (config.indent_size === 'tab' ? undefined : config.indent_size)
      if (typeof size === 'number') {
        result[filePath] = size
      }
    } catch {
      // skip files that fail to resolve
    }
  }
  return result
}

export function getUntrackedFilePaths(): string[] {
  const output = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  }).trim()
  return output ? output.split('\n') : []
}

function getUntrackedFilesDiff(): string {
  const root = getRepoRoot()
  const output = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  }).trim()

  if (!output) return ''

  const files = output.split('\n')
  const patches: string[] = []

  for (const file of files) {
    const entry = readWorktreeEntry(root, file)
    if (!entry) continue
    if (entry.type === 'symlink') {
      const targetLines = entry.target.split('\n')
      patches.push([
        `diff --git a/${file} b/${file}`,
        'new file mode 120000',
        'index 0000000..0000001',
        '--- /dev/null',
        `+++ b/${file}`,
        `@@ -0,0 +1${targetLines.length > 1 ? `,${targetLines.length}` : ''} @@`,
        ...targetLines.map((l) => `+${l}`),
        '\\ No newline at end of file',
      ].join('\n'))
    } else if (isBinaryContent(entry.content)) {
      const patch = [
        `diff --git a/${file} b/${file}`,
        'new file mode 100644',
        'index 0000000..0000001',
        `Binary files /dev/null and b/${file} differ`,
      ].join('\n')
      patches.push(patch)
    } else {
      const lines = entry.content.toString('utf-8').split('\n')
      const diffLines = lines.map((l: string) => `+${l}`)
      const patch = [
        `diff --git a/${file} b/${file}`,
        'new file mode 100644',
        'index 0000000..0000001',
        '--- /dev/null',
        `+++ b/${file}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...diffLines,
      ].join('\n')
      patches.push(patch)
    }
  }

  return patches.length > 0 ? '\n' + patches.join('\n') : ''
}

function tryRevParse(rev: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', rev], { encoding: 'utf-8', stdio: 'pipe' }).trim()
  } catch {
    return null
  }
}

// A range token like `A..B` or `A...B` names two revisions; anything else
// that isn't a flag (`--staged`) names one.
const REVISION_RANGE_REGEX = /^(.+?)(\.\.\.|\.\.)(.+)$/

function revisionTokensIn(args: string[]): string[] {
  const tokens: string[] = []
  for (const arg of args) {
    if (arg.startsWith('-')) continue
    const rangeMatch = arg.match(REVISION_RANGE_REGEX)
    if (rangeMatch) {
      tokens.push(rangeMatch[1], rangeMatch[3])
    } else {
      tokens.push(arg)
    }
  }
  return tokens
}

// Resolves the review identity for the given custom diff args
// (or the default working-tree mode when undefined). Runs `git rev-parse` for
// each named revision; falls back to the verbatim args plus HEAD when a
// revision cannot be resolved.
export function resolveReviewIdentity(customDiffArgs?: string[]): ReviewIdentity {
  const repoRoot = getRepoRoot()

  if (customDiffArgs === undefined) {
    return { repoRoot, args: [], revisions: [], head: tryRevParse('HEAD') ?? undefined }
  }

  const revisionTokens = revisionTokensIn(customDiffArgs)
  const revisions: string[] = []
  let resolvedAll = revisionTokens.length > 0
  for (const token of revisionTokens) {
    const sha = tryRevParse(token)
    if (sha === null) {
      resolvedAll = false
      break
    }
    revisions.push(sha)
  }

  if (!resolvedAll) {
    // Nothing revision-shaped in args (e.g. only flags), or a named
    // revision doesn't exist: fall back to the verbatim args plus HEAD.
    return { repoRoot, args: customDiffArgs, revisions: [], head: tryRevParse('HEAD') ?? undefined }
  }

  // A range (two or more named revisions) already pins both endpoints, so it
  // needs no HEAD. A single revision diffs against the working tree/index,
  // so HEAD is part of the identity.
  const head = revisions.length <= 1 ? tryRevParse('HEAD') ?? undefined : undefined
  return { repoRoot, args: customDiffArgs, revisions, head }
}

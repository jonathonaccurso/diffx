// Feature: send a review to the agent with Submit review.
//
// Given a repository with the one-commit range HEAD~1..HEAD and diffx --persist,
// When an agent waits on /api/rounds/wait and the reviewer clicks Submit review,
// Then the wait returns round 1 and the toolbar says the round is waiting for the agent,
// And after the agent posts /api/rounds/addressed the toolbar says round 1 is addressed,
// And after diffx restarts on the same range the round is still addressed.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CLI = join(REPO_ROOT, 'dist', 'cli.mjs')
const RANGE = 'HEAD~1..HEAD'

interface DiffxSession {
  url: string
  output: () => string
  stop: () => Promise<void>
}

let workDir: string
let fixtureRepo: string
let fakeHome: string
let browser: Browser
let context: BrowserContext
const running = new Set<ChildProcess>()

function isolatedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fakeHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(fakeHome, '.gitconfig'),
  }
  delete env.XDG_CONFIG_HOME
  return env
}

function git(...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=Reviewer', '-c', 'user.email=reviewer@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: fixtureRepo, env: isolatedEnv(), stdio: 'pipe' },
  )
}

function createFixtureRepo(): void {
  git('init', '-q', '-b', 'main')
  writeFileSync(join(fixtureRepo, 'greet.ts'), ["export function greet(name: string) {", "  return 'Hi ' + name", '}', ''].join('\n'))
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  writeFileSync(
    join(fixtureRepo, 'greet.ts'),
    ['export function greet(name: string) {', '  const message = `Hello, ${name}!`', '  return message', '}', ''].join('\n'),
  )
  git('add', '.')
  git('commit', '-q', '-m', 'head')
}

function buildDiffx(): void {
  // Vitest sets NODE_ENV=test, which makes vite build the client with the dev JSX
  // transform. The production react/jsx-runtime lacks it, so force production.
  const buildEnv = { ...process.env, NODE_ENV: 'production' }
  const run = (script: string, args: string[]) =>
    execFileSync(process.execPath, [join(REPO_ROOT, script), ...args], { cwd: REPO_ROOT, env: buildEnv, stdio: 'pipe' })
  run('node_modules/vite/bin/vite.js', ['build'])
  run('node_modules/tsdown/dist/run.mjs', [])
}

function startDiffx(flags: string[]): Promise<DiffxSession> {
  const child = spawn(process.execPath, [CLI, ...flags, '--no-open', '--', RANGE], {
    cwd: fixtureRepo,
    env: isolatedEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  running.add(child)
  let output = ''
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  exited.then(() => running.delete(child))

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`diffx did not start:\n${output}`)), 20_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(/diffx server running at (http:\/\/\S+)/)
      if (match) {
        clearTimeout(timer)
        resolve({
          url: match[1],
          output: () => output,
          stop: async () => {
            child.kill('SIGINT')
            await exited
          },
        })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`diffx exited with code ${code} before it started:\n${output}`))
    })
  })
}

async function openReview(url: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(url)
  await page.locator('.file-diff-card').first().waitFor()
  return page
}

interface RoundsState {
  round: number
  submittedAt: number | null
  addressedRound: number
  addressedAt: number | null
}

describe('send a review to the agent', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'diffx-send-to-agent-'))
    fixtureRepo = join(workDir, 'repo')
    fakeHome = join(workDir, 'home')
    mkdirSync(fixtureRepo)
    mkdirSync(fakeHome)
    createFixtureRepo()
    buildDiffx()
    browser = await chromium.launch()
    context = await browser.newContext()
  }, 180_000)

  afterAll(async () => {
    for (const child of running) child.kill('SIGKILL')
    await browser?.close()
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })

  it('wakes a waiting agent on Submit review and keeps the round across a restart', async () => {
    const first = await startDiffx(['--persist'])
    let page = await openReview(first.url)
    await expect.poll(async () => page.getByTestId('submit-review-state').textContent()).toBe('Not submitted')

    const waiting = fetch(`${first.url}/api/rounds/wait?after=0&timeout=60`).then((res) => res.json() as Promise<RoundsState>)
    await page.getByRole('button', { name: 'Submit review', exact: true }).click()

    expect((await waiting).round).toBe(1)
    await expect
      .poll(async () => page.getByTestId('submit-review-state').textContent())
      .toBe('Round 1 submitted, waiting for the agent')

    const addressed = await fetch(`${first.url}/api/rounds/addressed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ round: 1 }),
    })
    expect(addressed.status).toBe(200)
    await expect
      .poll(async () => page.getByTestId('submit-review-state').textContent(), { timeout: 10_000 })
      .toBe('Round 1 addressed')
    await page.close()
    await first.stop()

    const second = await startDiffx(['--persist'])
    page = await openReview(second.url)
    await expect.poll(async () => page.getByTestId('submit-review-state').textContent()).toBe('Round 1 addressed')
    const restored = (await (await fetch(`${second.url}/api/rounds`)).json()) as RoundsState
    expect(restored.round).toBe(1)
    expect(restored.addressedRound).toBe(1)
    await page.close()
    await second.stop()
  }, 120_000)
})

import { mkdtempSync } from 'node:fs'
import { get } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/server.js'
import { parseAfter, parseWaitTimeout } from '../../src/rounds.js'

function newApp() {
  return createApp({ clientDir: mkdtempSync(join(tmpdir(), 'diffx-server-rounds-')) })
}

type App = ReturnType<typeof createApp>

const post = (app: App, path: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const getFrom = async (app: App, path: string, init?: RequestInit) => app.request(path, init)

const settled = (promise: Promise<unknown>) => {
  let done = false
  promise.then(() => {
    done = true
  })
  return () => done
}

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/rounds', () => {
  it('starts at the defaults', async () => {
    const res = await newApp().request('/api/rounds')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ round: 0, submittedAt: null, addressedRound: 0, addressedAt: null })
  })
})

describe('POST /api/rounds/submit', () => {
  it('increments the round and stamps submittedAt', async () => {
    const app = newApp()

    const first = await (await post(app, '/api/rounds/submit')).json()
    const second = await (await post(app, '/api/rounds/submit')).json()

    expect(first.round).toBe(1)
    expect(typeof first.submittedAt).toBe('number')
    expect(second.round).toBe(2)
    expect(await (await app.request('/api/rounds')).json()).toEqual(second)
  })
})

describe('POST /api/rounds/addressed', () => {
  it('records the addressed round and time', async () => {
    const app = newApp()
    await post(app, '/api/rounds/submit')

    const res = await post(app, '/api/rounds/addressed', { round: 1 })

    expect(res.status).toBe(200)
    const state = await res.json()
    expect(state.round).toBe(1)
    expect(state.addressedRound).toBe(1)
    expect(typeof state.addressedAt).toBe('number')
  })

  it('rejects a round above the current round and leaves the state alone', async () => {
    const app = newApp()
    await post(app, '/api/rounds/submit')

    const res = await post(app, '/api/rounds/addressed', { round: 2 })

    expect(res.status).toBe(400)
    const state = await (await app.request('/api/rounds')).json()
    expect(state.addressedRound).toBe(0)
    expect(state.addressedAt).toBeNull()
  })

  it.each([
    ['a missing round', {}],
    ['a string round', { round: '1' }],
    ['a fractional round', { round: 0.5 }],
    ['a negative round', { round: -1 }],
  ])('rejects %s with 400', async (_name, body) => {
    const res = await post(newApp(), '/api/rounds/addressed', body)

    expect(res.status).toBe(400)
  })

  it('rejects a body that is not JSON with 400', async () => {
    const res = await newApp().request('/api/rounds/addressed', { method: 'POST', body: 'nope' })

    expect(res.status).toBe(400)
  })
})

describe('GET /api/rounds/wait', () => {
  it('returns immediately when the round is already above after', async () => {
    const app = newApp()
    await post(app, '/api/rounds/submit')

    const res = await getFrom(app, '/api/rounds/wait?after=0&timeout=300')

    expect(res.status).toBe(200)
    expect((await res.json()).round).toBe(1)
  })

  it('holds the request until a submit, then returns the new state', async () => {
    const app = newApp()
    const pending = getFrom(app, '/api/rounds/wait?after=0&timeout=300')
    const isDone = settled(pending)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(isDone()).toBe(false)

    await post(app, '/api/rounds/submit')
    const res = await pending

    expect(res.status).toBe(200)
    expect((await res.json()).round).toBe(1)
  })

  it('releases every pending waiter on one submit', async () => {
    const app = newApp()
    const waiters = [0, 0, 0].map(() => getFrom(app, '/api/rounds/wait?after=0&timeout=300'))

    await post(app, '/api/rounds/submit')
    const results = await Promise.all(waiters.map(async (waiting) => (await waiting).json()))

    expect(results.map((state) => state.round)).toEqual([1, 1, 1])
  })

  it('returns the unchanged state with 200 when the timeout passes', async () => {
    const app = newApp()

    const res = await getFrom(app, '/api/rounds/wait?after=0&timeout=0.05')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ round: 0, submittedAt: null, addressedRound: 0, addressedAt: null })
  })

  it('defaults to 30 seconds without a timeout', async () => {
    vi.useFakeTimers()
    const app = newApp()
    const isDone = settled(getFrom(app, '/api/rounds/wait?after=0'))

    await vi.advanceTimersByTimeAsync(29_900)
    expect(isDone()).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(isDone()).toBe(true)
  })

  it('falls back to the default for an invalid timeout', async () => {
    vi.useFakeTimers()
    const app = newApp()
    const isDone = settled(getFrom(app, '/api/rounds/wait?after=0&timeout=abc'))

    await vi.advanceTimersByTimeAsync(29_900)
    expect(isDone()).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(isDone()).toBe(true)
  })

  it('caps the timeout at 300 seconds', async () => {
    vi.useFakeTimers()
    const app = newApp()
    const isDone = settled(getFrom(app, '/api/rounds/wait?after=0&timeout=9999'))

    await vi.advanceTimersByTimeAsync(299_000)
    expect(isDone()).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(isDone()).toBe(true)
  })

  it('drops its timer and waiter when the client disconnects', async () => {
    vi.useFakeTimers()
    const app = newApp()
    const controller = new AbortController()
    const pending = getFrom(app, '/api/rounds/wait?after=0&timeout=300', { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(10)
    expect(vi.getTimerCount()).toBe(1)

    controller.abort()
    await pending.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(10)

    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the timer once a submit releases the waiter', async () => {
    vi.useFakeTimers()
    const app = newApp()
    const pending = getFrom(app, '/api/rounds/wait?after=0&timeout=300')
    await vi.advanceTimersByTimeAsync(10)
    expect(vi.getTimerCount()).toBe(1)

    await post(app, '/api/rounds/submit')
    await pending

    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('GET /api/rounds/wait over a real connection', () => {
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20))
    return check()
  }

  it('clears the waiter timer when the client closes the socket', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const app = newApp()
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
    await new Promise((resolve) => server.once('listening', resolve))
    const { port } = server.address() as AddressInfo

    const request = get(`http://127.0.0.1:${port}/api/rounds/wait?after=0&timeout=300`)
    request.on('error', () => undefined)
    const waiterTimer = () => {
      const index = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 300_000)
      return index === -1 ? undefined : setTimeoutSpy.mock.results[index].value
    }
    expect(await until(() => waiterTimer() !== undefined)).toBe(true)
    expect(clearTimeoutSpy).not.toHaveBeenCalledWith(waiterTimer())

    request.destroy()
    const cleared = await until(() => clearTimeoutSpy.mock.calls.some(([handle]) => handle === waiterTimer()))
    server.close()
    setTimeoutSpy.mockRestore()
    clearTimeoutSpy.mockRestore()

    expect(cleared).toBe(true)
  })
})

describe('query parsing', () => {
  it.each([
    [undefined, 30],
    ['', 30],
    ['abc', 30],
    ['-5', 30],
    ['NaN', 30],
    ['Infinity', 30],
    ['1e3', 30],
    ['0', 0],
    ['2.5', 2.5],
    ['300', 300],
    ['301', 300],
    ['99999', 300],
  ])('timeout %j gives %j seconds', (raw, expected) => {
    expect(parseWaitTimeout(raw)).toBe(expected)
  })

  it.each([
    [undefined, 0],
    ['abc', 0],
    ['-1', 0],
    ['1.5', 0],
    ['0', 0],
    ['7', 7],
  ])('after %j gives %j', (raw, expected) => {
    expect(parseAfter(raw)).toBe(expected)
  })
})

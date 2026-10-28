import type { RoundsState } from './types.js'

export const DEFAULT_WAIT_SECONDS = 30
export const MAX_WAIT_SECONDS = 300

export function initialRoundsState(): RoundsState {
  return { round: 0, submittedAt: null, addressedRound: 0, addressedAt: null }
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function nullableTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// Reads a rounds state from untrusted JSON (a review file). Anything
// malformed yields the defaults.
export function parseRoundsState(value: unknown): RoundsState {
  if (typeof value !== 'object' || value === null) return initialRoundsState()
  const raw = value as Record<string, unknown>
  const round = nonNegativeInt(raw.round)
  const addressedRound = nonNegativeInt(raw.addressedRound)
  if (round === null || addressedRound === null || addressedRound > round) return initialRoundsState()
  return {
    round,
    submittedAt: nullableTimestamp(raw.submittedAt),
    addressedRound,
    addressedAt: nullableTimestamp(raw.addressedAt),
  }
}

// Where the rounds state lives between requests.
export interface RoundsStore {
  getRounds(): RoundsState
  setRounds(state: RoundsState): void
}

export class InMemoryRoundsStore implements RoundsStore {
  private state = initialRoundsState()

  getRounds(): RoundsState {
    return { ...this.state }
  }

  setRounds(state: RoundsState): void {
    this.state = { ...state }
  }
}

// Seconds from the `timeout` query value: a plain non-negative number,
// clamped to MAX_WAIT_SECONDS. Anything else falls back to the default.
export function parseWaitTimeout(raw: string | undefined): number {
  if (raw === undefined || !/^\d+(\.\d+)?$/.test(raw)) return DEFAULT_WAIT_SECONDS
  return Math.min(Number(raw), MAX_WAIT_SECONDS)
}

// `after` query value: a non-negative integer, otherwise 0.
export function parseAfter(raw: string | undefined): number {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 0
}

export class ReviewRounds {
  private waiters = new Set<() => void>()

  constructor(private readonly store: RoundsStore) {}

  get(): RoundsState {
    return this.store.getRounds()
  }

  submit(): RoundsState {
    const current = this.store.getRounds()
    const next: RoundsState = { ...current, round: current.round + 1, submittedAt: Date.now() }
    this.store.setRounds(next)
    for (const release of [...this.waiters]) release()
    return next
  }

  // Returns null when `round` is above the current round.
  markAddressed(round: number): RoundsState | null {
    const current = this.store.getRounds()
    if (round > current.round) return null
    const next: RoundsState = { ...current, addressedRound: round, addressedAt: Date.now() }
    this.store.setRounds(next)
    return next
  }

  // Resolves with the state once `round > after`, after `timeoutSeconds`, or
  // when `signal` aborts. The timer and waiter are gone once it settles.
  wait(after: number, timeoutSeconds: number, signal?: AbortSignal): Promise<RoundsState> {
    if (this.store.getRounds().round > after || signal?.aborted) {
      return Promise.resolve(this.store.getRounds())
    }
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        this.waiters.delete(finish)
        signal?.removeEventListener('abort', finish)
        resolve(this.store.getRounds())
      }
      const timer = setTimeout(finish, timeoutSeconds * 1000)
      this.waiters.add(finish)
      signal?.addEventListener('abort', finish, { once: true })
    })
  }

  get pendingWaiters(): number {
    return this.waiters.size
  }
}

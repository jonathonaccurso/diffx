import { useQuery } from '@tanstack/react-query'
import type { DiffOptions } from './useDiff'

export const DIFF_FINGERPRINT_POLL_MS = 5000

export function diffFingerprintKey(options: DiffOptions) {
  return ['diff-fingerprint', options.staged, options.untracked] as const
}

async function fetchFingerprint(options: DiffOptions): Promise<string> {
  const res = await fetch(`/api/diff/fingerprint?staged=${options.staged}&untracked=${options.untracked}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()).fingerprint
}

// The options are part of the key, so switching them starts from no data
// instead of comparing against a fingerprint computed for other options.
export function useDiffFingerprint(options: DiffOptions): string | null {
  const { data } = useQuery({
    queryKey: diffFingerprintKey(options),
    queryFn: () => fetchFingerprint(options),
    refetchInterval: DIFF_FINGERPRINT_POLL_MS,
  })
  return data ?? null
}

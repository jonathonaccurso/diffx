import { useState, useEffect, useCallback, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { diffFingerprintKey } from './useDiffFingerprint'

export interface BinaryFileInfo {
  path: string
  type: 'added' | 'deleted' | 'changed' | 'untracked'
}

interface DiffData {
  patch: string
  fingerprint: string
  repoName: string
  branch: string
  customMode: boolean
  binaryFiles: BinaryFileInfo[]
  tabSizeMap: Record<string, number>
  untrackedFiles: string[]
}

export interface DiffOptions {
  staged: boolean
  untracked: boolean
}

async function fetchDiff(options: DiffOptions): Promise<DiffData> {
  const res = await fetch(`/api/diff?staged=${options.staged}&untracked=${options.untracked}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export function useDiff(options: DiffOptions) {
  const queryClient = useQueryClient()
  const [data, setData] = useState<DiffData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)
  const latestRequest = useRef(0)

  useEffect(() => {
    const request = ++latestRequest.current
    setLoading(true)
    setReloading(false)
    setError(null)

    fetchDiff(options)
      .then((json) => {
        if (request !== latestRequest.current) return
        setData(json)
        queryClient.setQueryData(diffFingerprintKey(options), json.fingerprint)
      })
      .catch((err) => {
        if (request === latestRequest.current) setError(err.message)
      })
      .finally(() => {
        if (request === latestRequest.current) setLoading(false)
      })
  }, [options.staged, options.untracked])

  // Refetches without touching `loading`, so the app stays mounted and open
  // comment drafts survive. A failed reload keeps the diff already on screen.
  const reload = useCallback(async () => {
    const request = ++latestRequest.current
    setReloading(true)
    try {
      const json = await fetchDiff(options)
      if (request !== latestRequest.current) return
      // A poll still in flight from before the reload would bring the banner back.
      await queryClient.cancelQueries({ queryKey: diffFingerprintKey(options) })
      setData(json)
      queryClient.setQueryData(diffFingerprintKey(options), json.fingerprint)
    } catch {
      // the banner stays up so the reviewer can retry
    } finally {
      if (request === latestRequest.current) setReloading(false)
    }
  }, [options.staged, options.untracked, queryClient])

  return {
    patch: data?.patch ?? null,
    fingerprint: data?.fingerprint ?? null,
    repoName: data?.repoName ?? '',
    branch: data?.branch ?? '',
    customMode: data?.customMode ?? false,
    binaryFiles: data?.binaryFiles ?? [],
    tabSizeMap: data?.tabSizeMap ?? {},
    untrackedFiles: data?.untrackedFiles ?? [],
    loading,
    error,
    reload,
    reloading,
  }
}

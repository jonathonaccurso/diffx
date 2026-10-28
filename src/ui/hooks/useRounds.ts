import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RoundsState } from '../../types'

export const ROUNDS_KEY = ['rounds']

async function fetchRounds(): Promise<RoundsState> {
  const res = await fetch('/api/rounds')
  return res.json()
}

export function useRounds() {
  const queryClient = useQueryClient()
  const { data: rounds } = useQuery({ queryKey: ROUNDS_KEY, queryFn: fetchRounds, refetchInterval: 3000 })

  const submitMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/rounds/submit', { method: 'POST' })
      return res.json() as Promise<RoundsState>
    },
    onSuccess: (state) => {
      queryClient.setQueryData<RoundsState>(ROUNDS_KEY, state)
    },
  })

  const submitReview = useCallback(() => {
    submitMutation.mutate()
  }, [submitMutation])

  return { rounds: rounds ?? null, submitReview, submitting: submitMutation.isPending }
}

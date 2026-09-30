import { useCallback, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { DiffLineAnnotation } from '@pierre/diffs'
import type { ReviewComment } from '../../types'
import { commentScope, formatComments } from '../../commentFormat'

export const COMMENTS_KEY = ['comments']

async function fetchComments(): Promise<ReviewComment[]> {
  const res = await fetch('/api/comments')
  return res.json()
}

export function useComments() {
  const queryClient = useQueryClient()
  const { data: comments = [] } = useQuery({ queryKey: COMMENTS_KEY, queryFn: fetchComments, refetchInterval: 3000 })

  const addMutation = useMutation({
    mutationFn: async (params: {
      scope?: 'file' | 'diff'
      filePath?: string
      side?: 'deletions' | 'additions'
      lineNumber?: number
      startLineNumber?: number
      lineContent?: string
      body: string
    }) => {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      return res.json() as Promise<ReviewComment>
    },
    onSuccess: (comment) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) => [...prev, comment])
    },
  })

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      await fetch(`/api/comments/${id}`, { method: 'DELETE' })
      return id
    },
    onSuccess: (id) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) => prev.filter((c) => c.id !== id))
    },
  })

  const editMutation = useMutation({
    mutationFn: async ({ id, body, status }: { id: string; body?: string; status?: ReviewComment['status'] }) => {
      const res = await fetch(`/api/comments/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, status }),
      })
      return res.json() as Promise<ReviewComment>
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      )
    },
  })

  const addComment = useCallback(
    (
      filePath: string,
      side: 'deletions' | 'additions',
      startLine: number,
      endLine: number,
      lineContent: string,
      body: string,
    ) => {
      addMutation.mutate({
        filePath,
        side,
        lineNumber: endLine,
        startLineNumber: startLine === endLine ? undefined : startLine,
        lineContent,
        body,
      })
    },
    [addMutation],
  )

  const addScopedComment = useCallback(
    (scope: 'file' | 'diff', filePath: string, body: string) => {
      addMutation.mutate({ scope, filePath, body })
    },
    [addMutation],
  )

  const removeComment = useCallback(
    (id: string) => {
      removeMutation.mutate(id)
    },
    [removeMutation],
  )

  const editComment = useCallback(
    (id: string, body: string) => {
      editMutation.mutate({ id, body })
    },
    [editMutation],
  )

  const resolveComment = useCallback(
    (id: string) => {
      editMutation.mutate({ id, status: 'resolved' })
    },
    [editMutation],
  )

  const formatAllComments = useCallback((): string => formatComments(comments), [comments])

  const getAnnotationsForFile = useCallback(
    (filePath: string): DiffLineAnnotation<ReviewComment>[] => {
      return comments
        .filter((c) => c.filePath === filePath && commentScope(c) === 'line')
        .map((c) => ({
          side: c.side,
          lineNumber: c.lineNumber,
          metadata: c,
        }))
    },
    [comments],
  )

  const copyAllComments = useCallback(async () => {
    const text = formatAllComments()
    await navigator.clipboard.writeText(text)
  }, [formatAllComments])

  return {
    comments,
    addComment,
    addScopedComment,
    removeComment,
    editComment,
    resolveComment,
    getAnnotationsForFile,
    formatAllComments,
    copyAllComments,
  }
}

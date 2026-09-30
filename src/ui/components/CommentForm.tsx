import { useState, useRef, useEffect } from 'react'

interface CommentFormProps {
  lineRange?: [number, number]
  initialBody?: string
  submitLabel?: string
  placeholder?: string
  onSubmit: (body: string) => void
  onCancel: () => void
}

export function CommentForm({ lineRange, initialBody, submitLabel, placeholder, onSubmit, onCancel }: CommentFormProps) {
  const [body, setBody] = useState(initialBody ?? '')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleSubmit = () => {
    const trimmed = body.trim()
    if (trimmed) {
      onSubmit(trimmed)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape') {
      onCancel()
    }
  }

  return (
    <div className="comment-form">
      {lineRange && (
        <div className="comment-form-range">
          Lines {lineRange[0]}-{lineRange[1]}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? 'Leave a review comment...'}
        rows={3}
      />
      <div className="comment-form-actions">
        <button className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={handleSubmit} disabled={!body.trim()}>
          {submitLabel ?? 'Comment'}
        </button>
      </div>
    </div>
  )
}

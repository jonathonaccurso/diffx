import type { RoundsState } from '../../types'

interface SubmitReviewControlProps {
  rounds: RoundsState | null
  submitting: boolean
  onSubmit: () => void
}

export function roundsLabel(rounds: RoundsState): string {
  if (rounds.round === 0) return 'Not submitted'
  if (rounds.addressedRound >= rounds.round) return `Round ${rounds.round} addressed`
  return `Round ${rounds.round} submitted, waiting for the agent`
}

export function SubmitReviewControl({ rounds, submitting, onSubmit }: SubmitReviewControlProps) {
  if (!rounds) return null

  return (
    <div className="submit-review">
      <span className="submit-review-state" role="status" data-testid="submit-review-state">
        {roundsLabel(rounds)}
      </span>
      <button
        className="btn btn-primary btn-sm"
        onClick={onSubmit}
        disabled={submitting}
        title="Send the review to the agent"
      >
        Submit review
      </button>
    </div>
  )
}

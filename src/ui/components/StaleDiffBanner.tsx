interface StaleDiffBannerProps {
  reloading: boolean
  onReload: () => void
}

export function StaleDiffBanner({ reloading, onReload }: StaleDiffBannerProps) {
  return (
    <div className="stale-diff-banner" role="status">
      <span>Files changed since this diff loaded.</span>
      <button className="btn btn-sm btn-primary" onClick={onReload} disabled={reloading}>
        Reload diff
      </button>
    </div>
  )
}

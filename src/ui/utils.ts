export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function truncate(text: string, maxLen: number): string {
  const firstLine = text.split('\n')[0]
  if (firstLine.length <= maxLen) return firstLine
  return firstLine.slice(0, maxLen) + '…'
}

export function fileName(filePath: string): string {
  const parts = filePath.split('/')
  return parts[parts.length - 1]
}

// Renderer lines keep their own terminator, so only unterminated lines in the
// middle of a span need one.
export function joinLines(lines: string[]): string {
  return lines.map((line, i) => (i < lines.length - 1 && !line.endsWith('\n') ? `${line}\n` : line)).join('')
}

export function isDiffStale(loadedFingerprint: string | null, currentFingerprint: string | null): boolean {
  return loadedFingerprint !== null && currentFingerprint !== null && loadedFingerprint !== currentFingerprint
}

// FNV-1a over the lines, for React keys that must change when file content does.
export function contentSignature(lines: string[]): string {
  let hash = 0x811c9dc5
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      hash = Math.imul(hash ^ line.charCodeAt(i), 0x01000193)
    }
    hash = Math.imul(hash ^ 0x0a, 0x01000193)
  }
  return `${lines.length}-${(hash >>> 0).toString(16)}`
}

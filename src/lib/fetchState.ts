const LAST_FETCH_KEY = (repoPath: string) => `lucid-git:last-fetch:${repoPath}`
const FETCH_EVENT = 'lucid-git:fetch-performed'

export function getLastFetch(repoPath: string): number | null {
  const raw = localStorage.getItem(LAST_FETCH_KEY(repoPath))
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

export function markFetchPerformed(repoPath: string): number {
  const now = Date.now()
  localStorage.setItem(LAST_FETCH_KEY(repoPath), String(now))
  window.dispatchEvent(new CustomEvent(FETCH_EVENT, { detail: { repoPath, at: now } }))
  return now
}

export function onFetchPerformed(listener: (repoPath: string, at: number) => void): () => void {
  const handler = (event: Event) => {
    const custom = event as CustomEvent<{ repoPath?: string; at?: number }>
    const repoPath = custom.detail?.repoPath
    const at = custom.detail?.at
    if (!repoPath || typeof at !== 'number') return
    listener(repoPath, at)
  }
  window.addEventListener(FETCH_EVENT, handler)
  return () => window.removeEventListener(FETCH_EVENT, handler)
}

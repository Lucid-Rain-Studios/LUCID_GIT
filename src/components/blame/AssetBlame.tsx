import { useEffect, useRef, useState } from 'react'
import { ipc, type CommitEntry } from '@/ipc'

const DISPLAY_BATCH = 20
const HISTORY_BATCH = 100

/** Binary packages have file-level authorship, rather than readable line blame. */
export function AssetBlame({ repoPath, filePath, revision, active }: { repoPath: string; filePath: string; revision: string; active: boolean }) {
  const ref = revision === 'WORKING' || revision === 'INDEX' ? 'HEAD' : revision
  const key = JSON.stringify([repoPath, filePath, ref])
  const [display, setDisplay] = useState({ key, count: DISPLAY_BATCH })
  const visibleCount = display.key === key ? display.count : DISPLAY_BATCH
  // Keep one extra entry to detect older history without a separate Git read.
  const limit = Math.ceil(visibleCount / HISTORY_BATCH) * HISTORY_BATCH + 1
  const requestKey = JSON.stringify([key, limit])
  const loadedRequest = useRef('')
  const [result, setResult] = useState<{ key: string; limit: number; commits: CommitEntry[] } | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (!active) return
    setError('')
    if (loadedRequest.current === requestKey || ref === 'ABSENT') return
    let cancelled = false
    ipc.log(repoPath, { filePath, refs: [ref], limit }).then(commits => {
      if (cancelled) return
      loadedRequest.current = requestKey
      setResult({ key, limit, commits })
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { cancelled = true }
  }, [active, repoPath, filePath, ref, key, limit, requestKey, retry])

  const history = result?.key === key ? result : null
  const commits = history?.commits.slice(0, Math.min(visibleCount, history.limit - 1))
  const hasMore = history && commits && history.commits.length > commits.length
  const loadingMore = !!history && history.limit !== limit && !error
  const loadError = error && <div role="alert">Could not load blame: {error} <button type="button" className="lg-toolbar-control" onClick={() => setRetry(value => value + 1)}>Retry blame</button></div>

  return <section className="uar-asset-blame" aria-label="Asset blame" hidden={!active}>
    <p>Binary asset · file history at <code>{ref}</code>. Line-by-line blame is unavailable.</p>
    {(revision === 'WORKING' || revision === 'INDEX') && <p>Showing committed changes through HEAD. Local changes have no commit author yet.</p>}
    {ref === 'ABSENT' ? <p role="status">File absent in this revision. Select the other revision to see its history.</p> : !commits ? loadError || <p role="status">Loading blame…</p> : commits.length === 0 ? <p role="status">No committed history for this file at this revision.</p> : <>
      <p>Most recent {commits.length} file commit{commits.length === 1 ? '' : 's'}</p>
      <ol>{commits.map(commit => <li key={commit.hash}>
        <div><code title={commit.hash}>{commit.hash.slice(0, 7)}</code><strong title={commit.author}>{commit.author}</strong>
          <time dateTime={new Date(commit.timestamp).toISOString()}>{new Date(commit.timestamp).toLocaleString()}</time>
        </div>
        <p>{commit.message}</p>
      </li>)}</ol>
      {loadError || (hasMore && <button type="button" className="lg-toolbar-control" disabled={loadingMore} onClick={() => setDisplay({ key, count: visibleCount + DISPLAY_BATCH })}>
        {loadingMore ? 'Loading older commits…' : 'Show More'}
      </button>)}
    </>}
  </section>
}

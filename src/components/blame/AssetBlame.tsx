import { useEffect, useRef, useState } from 'react'
import { ipc, type CommitEntry } from '@/ipc'

/** Binary packages have file-level authorship, rather than readable line blame. */
export function AssetBlame({ repoPath, filePath, revision, active }: { repoPath: string; filePath: string; revision: string; active: boolean }) {
  const ref = revision === 'WORKING' || revision === 'INDEX' ? 'HEAD' : revision
  const key = JSON.stringify([repoPath, filePath, ref])
  const loadedKey = useRef('')
  const [result, setResult] = useState<{ key: string; commits: CommitEntry[] } | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (!active) return
    setError('')
    if (loadedKey.current === key || ref === 'ABSENT') return
    let cancelled = false
    ipc.log(repoPath, { filePath, refs: [ref], limit: 100 }).then(commits => {
      if (cancelled) return
      loadedKey.current = key
      setResult({ key, commits })
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { cancelled = true }
  }, [active, repoPath, filePath, ref, key, retry])

  const commits = result?.key === key ? result.commits : null
  return <section className="uar-asset-blame" aria-label="Asset blame" hidden={!active}>
    <p>Binary asset · file history at <code>{ref}</code>. Line-by-line blame is unavailable.</p>
    {(revision === 'WORKING' || revision === 'INDEX') && <p>Showing committed changes through HEAD. Local changes have no commit author yet.</p>}
    {ref === 'ABSENT' ? <p role="status">File absent in this revision. Select the other revision to see its history.</p> : error ? <div role="alert">Could not load blame: {error} <button className="lg-toolbar-control" onClick={() => setRetry(value => value + 1)}>Retry blame</button></div> : !commits ? <p role="status">Loading blame…</p> : commits.length === 0 ? <p role="status">No committed history for this file at this revision.</p> : <>
      <p>Most recent {commits.length} file commit{commits.length === 1 ? '' : 's'}{commits.length === 100 ? ' (limited to 100)' : ''}</p>
      <ol>{commits.map(commit => <li key={commit.hash}>
        <div><code title={commit.hash}>{commit.hash.slice(0, 7)}</code><strong>{commit.author}</strong></div>
        <time dateTime={new Date(commit.timestamp).toISOString()}>{new Date(commit.timestamp).toLocaleString()}</time>
        <p>{commit.message}</p>
      </li>)}</ol>
    </>}
  </section>
}

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, MoreVertical } from 'lucide-react'
import { ipc, type BranchDiffFile, type BranchDiffSummary, type ConflictPreviewFile, type DiffContent, type PullRequest } from '@/ipc'
import { FileDetailsSidePanel, isPreviewAsset } from '@/components/shared/FileDetailsSidePanel'
import { RevisionFileActions } from '@/components/shared/RevisionFileActions'
import { AppRightSelectionOptions } from '@/components/ui/AppRightSelectionOptions'

export type PRFileChoices = Record<string, 'head' | 'base'>

function ConflictChoices({ path, pr, choices, busy, onChoose }: {
  path: string; pr: PullRequest; choices: PRFileChoices; busy: boolean
  onChoose(path: string, side: 'head' | 'base'): void
}) {
  return <>{(['base', 'head'] as const).map(side => <button key={side} className="pr-file-choice"
    disabled={busy} aria-pressed={choices[path] === side}
    title={`Use the whole file from ${side === 'base' ? pr.baseBranch : pr.headBranch} when merging`}
    onClick={() => onChoose(path, side)}>
    {side === 'base' ? `Keep ${pr.baseBranch}` : `Accept ${pr.headBranch}`}
  </button>)}</>
}

/** PR-specific selection and choices around the same revision previews and
 * read-only actions used by Timeline. Nothing is extracted for unselected rows. */
export function PRReviewWorkspace({ pr, repoPath, ghSlug, summary, loading, error, conflicts, choices, busy, onChoose }: {
  pr: PullRequest; repoPath: string; ghSlug: string; summary: BranchDiffSummary | null
  loading: boolean; error: string | null; conflicts: ConflictPreviewFile[]
  choices: PRFileChoices; busy: boolean; onChoose(path: string, side: 'head' | 'base'): void
}) {
  const [selectedPath, setSelectedPath] = useState('')
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [details, setDetails] = useState(false)
  const [unsupportedPath, setUnsupportedPath] = useState('')
  const [diffState, setDiffState] = useState<{ key: string; diff?: DiffContent; error?: string } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; file: BranchDiffFile } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuOrigin = useRef<HTMLElement | null>(null)
  const files = useMemo(() => {
    const all = new Map((summary?.files ?? []).map(file => [file.path, file]))
    for (const file of conflicts) if (!all.has(file.path)) all.set(file.path, { path: file.path, status: 'M', additions: 0, deletions: 0 })
    return [...all.values()]
  }, [summary, conflicts])
  const active = files.find(file => file.path === selectedPath) ?? files.find(file => conflicts.some(c => c.path === file.path)) ?? files[0]
  const conflict = conflicts.find(file => file.path === active?.path)
  const remoteUrl = `https://github.com/${ghSlug}`
  const selectedRevision = active?.status === 'D' ? pr.baseSha : pr.headSha
  const previewKey = `${repoPath}|${active?.path}|${active?.oldPath}|${pr.baseSha}|${pr.headSha}`
  const isAsset = !!active && isPreviewAsset(active.path)
  const activePath = active?.path
  const activeOldPath = active?.oldPath
  const isBlueprint = !!active && /\.uasset$/i.test(active.path) && unsupportedPath !== active.path
  const select = (file: BranchDiffFile) => { setSelectedPath(file.path); setDetails(false) }
  const closeMenu = () => { setMenu(null); menuOrigin.current?.focus() }
  const openMenu = (event: React.MouseEvent<HTMLElement>, file: BranchDiffFile) => {
    event.preventDefault(); event.stopPropagation(); menuOrigin.current = event.currentTarget
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ x: event.detail === 0 ? rect.left : event.clientX, y: event.detail === 0 ? rect.bottom : event.clientY, file })
  }

  useEffect(() => {
    if (!activePath || isAsset || loading || error) return
    let cancelled = false
    setDiffState(null)
    ipc.gitCommitFileDiff(repoPath, activePath, pr.headSha, pr.baseSha, activeOldPath)
      .then(diff => { if (!cancelled) setDiffState({ key: previewKey, diff }) })
      .catch(reason => { if (!cancelled) setDiffState({ key: previewKey, error: String(reason) }) })
    return () => { cancelled = true }
  }, [repoPath, activePath, activeOldPath, pr.baseSha, pr.headSha, previewKey, isAsset, loading, error])

  useEffect(() => {
    if (!menu) return
    const outside = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null) }
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); menuOrigin.current?.focus() }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
      }
    }
    document.addEventListener('mousedown', outside)
    // Capture Escape before the containing dialog's dismissal listener.
    document.addEventListener('keydown', keys, true)
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', keys, true) }
  }, [menu])
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return
    const element = menuRef.current
    element.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - element.offsetWidth - 4))}px`
    element.style.top = `${Math.max(4, Math.min(menu.y, window.innerHeight - element.offsetHeight - 4))}px`
  }, [menu])

  return <div className="pr-review-workspace">
    <aside className="pr-review-files" aria-label="PR changed files">
      <div className="pr-review-files-heading"><strong>Commits and file changes</strong><small>{summary ? `${summary.aheadCommits.length} commit${summary.aheadCommits.length === 1 ? '' : 's'} · ${files.length} files` : 'Loading commit details…'}</small></div>
      <div className="pr-review-commits">{summary?.aheadCommits.map(commit => <div className="pr-review-commit" key={commit.hash}><strong>{commit.message}</strong><small>{commit.hash.slice(0, 7)} · {commit.author}</small></div>)}</div>
      <input className="pr-review-filter" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter files…" aria-label="Filter changed files" />
      <div className="pr-review-file-list">
        {loading && <p className="pr-review-message">Loading review…</p>}
        {error && <p className="pr-review-error" role="alert">{error}</p>}
        {files.filter(file => file.path.toLowerCase().includes(filter.toLowerCase())).map(file => {
          const needsChoice = conflicts.some(c => c.path === file.path)
          return <div className={`pr-review-file ${active?.path === file.path ? 'selected' : ''}`} key={file.path}
            onContextMenu={event => openMenu(event, file)}>
            <button className="pr-review-file-select" disabled={busy} aria-pressed={active?.path === file.path} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              onClick={() => select(file)} onKeyDown={event => {
                if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
                  event.preventDefault(); menuOrigin.current = event.currentTarget
                  const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom, file })
                }
              }}>
              <span className={needsChoice ? 'pr-conflict-tone' : 'pr-review-status'}>{needsChoice ? choices[file.path] ? '✓' : '!' : file.status}</span>
              <span><strong>{file.path.split('/').pop()}</strong><small>{file.path.slice(0, file.path.lastIndexOf('/')) || '/'}</small>
                {/\.uasset$/i.test(file.path) && <small className="pr-blueprint-tone">◇ BP Graph View</small>}
                {needsChoice && <small className={choices[file.path] ? 'pr-chosen-tone' : 'pr-conflict-tone'}>{choices[file.path] ? `Keep ${choices[file.path] === 'head' ? pr.headBranch : pr.baseBranch}` : 'Conflict · Needs a choice'}</small>}
              </span>
            </button>
            {needsChoice && <div className="pr-review-file-choices"><ConflictChoices path={file.path} pr={pr} choices={choices} busy={busy} onChoose={onChoose} /></div>}
          </div>
        })}
        {!loading && !error && !files.some(file => file.path.toLowerCase().includes(filter.toLowerCase())) && <p className="pr-review-message">{files.length ? 'No matching files' : 'No changed files'}</p>}
      </div>
      <div className="pr-review-files-note">Blueprint assets open in BP Graph View.<br />Other assets open in Binary details.</div>
    </aside>
    <section className="pr-review-selected" aria-label="Selected file review">
      {!active ? <div className="pr-review-empty">{loading ? 'Loading review…' : 'Select a file to review'}</div> : <>
        <header className="pr-review-selected-header"><div><strong>{active.path.split('/').pop()}</strong><small title={active.path}>{active.path}</small></div>
          <button aria-pressed={details} onClick={() => setDetails(!details)}>{details ? 'Back to preview' : 'Details'}</button>
          <button aria-label="Selected file actions" onClick={event => openMenu(event, active)}><MoreVertical size={15} /></button>
        </header>
        {conflict && <div className="pr-review-conflict"><span>! {conflict.autoResolved ? 'Auto-resolved · Review choice' : conflict.conflictType === 'binary' ? 'Binary conflict' : conflict.conflictType === 'delete-modify' ? 'Delete / modify conflict' : 'Text conflict'}</span><small>Choose file revision</small><div><ConflictChoices path={active.path} pr={pr} choices={choices} busy={busy} onChoose={onChoose} /></div></div>}
        <button className="pr-review-collapse" aria-expanded={!collapsed} aria-controls="pr-file-preview" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}{isBlueprint ? 'BP Graph View' : isAsset ? 'Binary details' : 'File diff'}
        </button>
        <div id="pr-file-preview" className="pr-review-preview" style={{ display: collapsed || details ? 'none' : 'flex' }}>
          {loading || error ? <p className="pr-review-message">{error || 'Loading review…'}</p> : <>
            {diffState?.key === previewKey && diffState.error && <p className="pr-review-error" role="alert">{diffState.error}</p>}
            <FileDetailsSidePanel repoPath={repoPath} filePath={active.path} hash={selectedRevision} remoteUrl={remoteUrl}
              diff={diffState?.key === previewKey ? diffState.diff : undefined} diffLoading={!isAsset && diffState?.key !== previewKey}
              blueprintRequest={{ filePath: active.path, oldPath: active.oldPath, leftRef: pr.baseSha, rightRef: pr.headSha }}
              blueprintFiles={files.filter(file => /\.uasset$/i.test(file.path)).map(file => ({ path: file.path, selected: file.path === active.path, onSelect: () => select(file) }))}
              revisionLabels={{ left: `Current ${pr.baseBranch}`, right: `Incoming ${pr.headBranch}` }}
              onBlueprintUnsupported={() => setUnsupportedPath(active.path)} blame={[]} blameLoading={false} />
          </>}
        </div>
        {details && <div className="pr-review-preview"><FileDetailsSidePanel key={`${active.path}|${selectedRevision}`} mode="details" repoPath={repoPath} filePath={active.path} hash={selectedRevision} remoteUrl={remoteUrl} blame={[]} blameLoading={false} /></div>}
        {collapsed && !details && <div className="pr-review-empty">Preview collapsed</div>}
      </>}
    </section>
    {menu && <AppRightSelectionOptions x={menu.x} y={menu.y} menuRef={menuRef}>
      <div data-dialog-menu>
      <RevisionFileActions repoPath={repoPath} filePath={menu.file.path} revision={menu.file.status === 'D' ? pr.baseSha : pr.headSha} remoteUrl={remoteUrl} onClose={closeMenu}
        onDetails={() => { setSelectedPath(menu.file.path); setDetails(true) }} />
      </div>
    </AppRightSelectionOptions>}
  </div>
}

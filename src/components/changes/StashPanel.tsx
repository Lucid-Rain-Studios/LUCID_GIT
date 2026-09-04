import React, { useEffect, useMemo, useState } from 'react'
import { ipc, StashEntry, CommitFileChange, DiffContent } from '@/ipc'
import { useOperationStore } from '@/stores/operationStore'
import { useRepoStore } from '@/stores/repoStore'
import { useDialogStore } from '@/stores/dialogStore'
import { ActionBtn } from '@/components/ui/ActionBtn'
import { AppCheckbox } from '@/components/ui/AppCheckbox'
import { TextDiff } from '@/components/diff/TextDiff'

interface StashPanelProps {
  repoPath: string
  onRefresh: () => void
}

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60)    return 'just now'
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export function StashPanel({ repoPath, onRefresh }: StashPanelProps) {
  const [stashes, setStashes]       = useState<StashEntry[]>([])
  const [loading, setLoading]       = useState(false)
  const [message, setMessage]       = useState('')
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const [actionId, setActionId]     = useState<number | null>(null)

  // Partial-stash UI: pick a subset of working-tree paths to stash.
  const [pickerOpen, setPickerOpen] = useState(false)
  const [picked, setPicked]         = useState<Set<string>>(new Set())

  // Diff viewer: shows the contents of a single stash entry.
  const [viewing, setViewing]       = useState<StashEntry | null>(null)

  const opRun = useOperationStore(s => s.run)
  const fileStatus = useRepoStore(s => s.fileStatus)
  const dialog = useDialogStore()

  const stashableFiles = useMemo(
    () => fileStatus.filter(f => f.workingStatus !== '?'),
    [fileStatus],
  )

  const load = async () => {
    setLoading(true)
    try { setStashes(await ipc.stashList(repoPath)) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [repoPath])

  const handleSave = async () => {
    setSaving(true); setError(null)
    try {
      await opRun('Stashing changes…', () => ipc.stashSave(repoPath, message || undefined))
      setMessage('')
      await load()
      onRefresh()
    } catch (e) { setError(String(e)) } finally { setSaving(false) }
  }

  const handleSavePartial = async () => {
    if (picked.size === 0) return
    setSaving(true); setError(null)
    try {
      await opRun(
        `Stashing ${picked.size} file${picked.size !== 1 ? 's' : ''}…`,
        () => ipc.stashSave(repoPath, message || undefined, Array.from(picked)),
      )
      setMessage('')
      setPicked(new Set())
      setPickerOpen(false)
      await load()
      onRefresh()
    } catch (e) { setError(String(e)) } finally { setSaving(false) }
  }

  const wrap = async (label: string, entry: StashEntry, op: () => Promise<void>) => {
    setActionId(entry.index); setError(null)
    try { await opRun(label, op); await load(); onRefresh() }
    catch (e) { setError(String(e)) }
    finally { setActionId(null) }
  }

  const handlePop   = (e: StashEntry) => wrap('Applying stash…', e, () => ipc.stashPop(repoPath, e.ref))
  const handleApply = (e: StashEntry) => wrap('Applying stash…', e, () => ipc.stashApply(repoPath, e.ref))

  const handleDrop = async (entry: StashEntry) => {
    const ok = await dialog.confirm({
      title: 'Drop stash',
      message: `Drop "${entry.message}"?`,
      detail: 'This permanently removes the stash entry. The change cannot be recovered.',
      confirmLabel: 'Drop', danger: true,
    })
    if (!ok) return
    setActionId(entry.index); setError(null)
    try { await opRun('Dropping stash…', () => ipc.stashDrop(repoPath, entry.ref)); await load() }
    catch (e) { setError(String(e)) }
    finally { setActionId(null) }
  }

  const togglePick = (path: string) =>
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Create stash */}
      <div className="p-2.5 border-b border-lg-border space-y-2 shrink-0">
        <input
          value={message}
          onChange={e => setMessage(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !saving && !pickerOpen && handleSave()}
          placeholder="Stash message (optional)"
          className="w-full bg-lg-bg-primary border border-lg-border rounded px-2 py-1.5 text-xs font-mono text-lg-text-primary placeholder:text-lg-text-secondary focus:outline-none focus:border-lg-accent transition-colors"
        />
        <div className="flex gap-1.5">
          <ActionBtn
            onClick={handleSave}
            disabled={saving || pickerOpen}
            size="sm"
            style={{ flex: 1, height: 28, fontSize: 11 }}
          >
            {saving && !pickerOpen ? 'Stashing…' : 'Stash all changes'}
          </ActionBtn>
          <ActionBtn
            onClick={() => { setPickerOpen(p => !p); setPicked(new Set()) }}
            disabled={saving || stashableFiles.length === 0}
            size="sm"
            style={{ height: 28, fontSize: 11, paddingLeft: 10, paddingRight: 10 }}
            title={stashableFiles.length === 0 ? 'No tracked changes to stash' : 'Stash only selected files'}
          >
            {pickerOpen ? 'Cancel' : 'Stash files…'}
          </ActionBtn>
        </div>

        {pickerOpen && (
          <div className="border border-lg-border rounded bg-lg-bg-primary">
            <div className="max-h-40 overflow-y-auto">
              {stashableFiles.length === 0 ? (
                <div className="px-2 py-3 text-[10px] font-mono text-lg-text-secondary text-center">
                  No tracked changes to stash
                </div>
              ) : stashableFiles.map(f => (
                <label
                  key={f.path}
                  className="flex items-center gap-2 px-2 py-1.5 hover:bg-lg-bg-elevated cursor-pointer"
                >
                  <AppCheckbox
                    checked={picked.has(f.path)}
                    onChange={() => togglePick(f.path)}
                    color="#f5a832"
                  />
                  <span className="text-[10px] font-mono text-lg-text-primary truncate flex-1" title={f.path}>
                    {f.path}
                  </span>
                </label>
              ))}
            </div>
            <div className="flex items-center gap-1.5 p-1.5 border-t border-lg-border">
              <span className="text-[10px] font-mono text-lg-text-secondary flex-1">
                {picked.size} of {stashableFiles.length} selected
              </span>
              <ActionBtn
                onClick={handleSavePartial}
                disabled={saving || picked.size === 0}
                size="sm"
                style={{ height: 22, fontSize: 10, paddingLeft: 8, paddingRight: 8 }}
              >
                {saving ? 'Stashing…' : `Stash ${picked.size || ''}`}
              </ActionBtn>
            </div>
          </div>
        )}

        {error && (
          <div className="text-[10px] font-mono text-lg-error" title={error}>{error}</div>
        )}
      </div>

      {/* Stash list */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs font-mono text-lg-text-secondary animate-pulse">Loading…</span>
          </div>
        )}
        {!loading && stashes.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs font-mono text-lg-text-secondary">No stashes</span>
          </div>
        )}
        {!loading && stashes.map(entry => (
          <div
            key={entry.ref}
            className="px-3 py-2.5 border-b border-lg-border/50 hover:bg-lg-bg-elevated transition-colors"
          >
            <div className="flex items-start justify-between gap-2 mb-1">
              <div className="min-w-0">
                <div className="text-[11px] font-mono text-lg-text-primary font-semibold truncate" title={entry.message}>
                  {entry.message}
                </div>
                <div className="text-[9px] font-mono text-lg-text-secondary mt-0.5">
                  {entry.ref}
                  {entry.branch && ` · ${entry.branch}`}
                  {entry.date && ` · ${timeAgo(entry.date)}`}
                </div>
              </div>
            </div>
            <div className="flex gap-1 mt-1.5 flex-wrap">
              <StashBtn label="View" busy={false} onClick={() => setViewing(entry)} title="View changes captured in this stash" />
              <StashBtn label="Pop"   busy={actionId === entry.index} onClick={() => handlePop(entry)}  title="Apply and remove from stash list" />
              <StashBtn label="Apply" busy={actionId === entry.index} onClick={() => handleApply(entry)} title="Apply and keep in stash list" />
              <StashBtn label="Drop"  busy={actionId === entry.index} onClick={() => handleDrop(entry)} danger title="Delete this stash" />
            </div>
          </div>
        ))}
      </div>

      {viewing && (
        <StashDiffOverlay
          repoPath={repoPath}
          entry={viewing}
          onClose={() => setViewing(null)}
          onPop={async () => {
            const e = viewing
            setViewing(null)
            await handlePop(e)
          }}
          onApply={async () => {
            const e = viewing
            setViewing(null)
            await handleApply(e)
          }}
        />
      )}
    </div>
  )
}

function StashBtn({
  label, busy, onClick, danger, title,
}: {
  label: string; busy: boolean; onClick: () => void; danger?: boolean; title?: string
}) {
  return (
    <ActionBtn
      onClick={onClick}
      disabled={busy}
      title={title}
      color={danger ? '#e84545' : undefined}
      size="sm"
      style={{ height: 22, paddingLeft: 8, paddingRight: 8, fontSize: 10 }}
    >
      {label}
    </ActionBtn>
  )
}

// ── Stash diff overlay ────────────────────────────────────────────────────────

function StashDiffOverlay({
  repoPath, entry, onClose, onPop, onApply,
}: {
  repoPath: string
  entry: StashEntry
  onClose: () => void
  onPop:   () => void
  onApply: () => void
}) {
  const [files, setFiles] = useState<CommitFileChange[]>([])
  const [filesLoading, setFilesLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff]         = useState<DiffContent | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  useEffect(() => {
    setFilesLoading(true)
    ipc.stashShowFiles(repoPath, entry.ref).then(list => {
      setFiles(list)
      setSelected(list[0]?.path ?? null)
    }).finally(() => setFilesLoading(false))
  }, [repoPath, entry.ref])

  useEffect(() => {
    if (!selected) { setDiff(null); return }
    setDiffLoading(true)
    ipc.stashFileDiff(repoPath, entry.ref, selected)
      .then(setDiff)
      .catch(() => setDiff(null))
      .finally(() => setDiffLoading(false))
  }, [repoPath, entry.ref, selected])

  return (
    <div
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{
        width: '92%', maxWidth: 1100, height: '82%',
        background: 'var(--lg-bg-secondary)', border: '1px solid var(--lg-border)',
        borderRadius: 8, boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px', borderBottom: '1px solid var(--lg-border)',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--lg-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entry.message}
            </div>
            <div style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: 'var(--lg-text-secondary)' }}>
              {entry.ref}{entry.branch && ` · ${entry.branch}`}
            </div>
          </div>
          <ActionBtn onClick={onApply} size="sm" style={{ height: 24, fontSize: 11 }}>Apply</ActionBtn>
          <ActionBtn onClick={onPop}   size="sm" style={{ height: 24, fontSize: 11 }} color="#2dbd6e">Pop</ActionBtn>
          <ActionBtn onClick={onClose} size="sm" style={{ height: 24, fontSize: 11 }}>Close</ActionBtn>
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* File list */}
          <div style={{
            width: 260, borderRight: '1px solid var(--lg-border)',
            overflowY: 'auto', flexShrink: 0,
          }}>
            {filesLoading ? (
              <div style={{ padding: 16, fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: 'var(--lg-text-secondary)' }}>
                Loading files…
              </div>
            ) : files.length === 0 ? (
              <div style={{ padding: 16, fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: 'var(--lg-text-secondary)' }}>
                No files in stash
              </div>
            ) : files.map(f => {
              const isSel = selected === f.path
              return (
                <button
                  key={f.path}
                  onClick={() => setSelected(f.path)}
                  style={{
                    width: '100%', textAlign: 'left',
                    padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6,
                    background: isSel ? 'rgba(74,158,255,0.14)' : 'transparent',
                    border: 'none', cursor: 'pointer',
                    borderLeft: isSel ? '2px solid var(--lg-accent)' : '2px solid transparent',
                    fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: 'var(--lg-text-primary)',
                  }}
                  onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'var(--lg-bg-elevated)' }}
                  onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent' }}
                >
                  <span style={{
                    width: 16, fontWeight: 700, flexShrink: 0,
                    color: f.status === 'A' ? '#2ec573' : f.status === 'D' ? '#e84545' : '#f5a832',
                  }}>{f.status}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>
                    {f.path}
                  </span>
                </button>
              )
            })}
          </div>

          {/* Diff */}
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
            {diffLoading && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0d0f15' }}>
                <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 12, color: '#344057' }}>Loading diff…</span>
              </div>
            )}
            {!diffLoading && diff && <TextDiff diff={diff} />}
            {!diffLoading && !diff && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 13, color: '#2e3a50' }}>No diff available</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

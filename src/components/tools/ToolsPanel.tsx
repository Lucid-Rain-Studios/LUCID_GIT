import React, { useEffect, useState } from 'react'
import { ipc, BranchInfo, CommitEntry } from '@/ipc'
import { useOperationStore } from '@/stores/operationStore'
import { useDialogStore } from '@/stores/dialogStore'
import { useRepoStore } from '@/stores/repoStore'
import { FilePathText } from '@/components/ui/FilePathText'

interface ToolsPanelProps {
  repoPath: string
  onRefresh: () => void
  /** Called when a cherry-pick fails with a conflict — host opens the conflict dialog. */
  onCherryPickConflict?: () => void
}

type ToolId = 'restore' | 'revert' | 'cherrypick' | 'reset'

const TOOLS: { id: ToolId; label: string; icon: string; desc: string }[] = [
  { id: 'restore',    label: 'Restore File',    icon: '↩', desc: 'Bring a file back to its state at any past commit' },
  { id: 'revert',     label: 'Revert Commit',   icon: '⎌', desc: 'Create a new commit that undoes a specific commit' },
  { id: 'cherrypick', label: 'Cherry-pick',      icon: '🍒', desc: 'Apply changes from a single commit to HEAD' },
  { id: 'reset',      label: 'Reset to Commit',  icon: '⏮', desc: 'Move HEAD and optionally the index / working tree' },
]

export function ToolsPanel({ repoPath, onRefresh, onCherryPickConflict }: ToolsPanelProps) {
  const [activeTool, setActiveTool] = useState<ToolId>('restore')
  const opRun = useOperationStore(s => s.run)
  const bumpSyncTick = useRepoStore(s => s.bumpSyncTick)

  const run = async (label: string, fn: () => Promise<void>) => {
    try { await opRun(label, fn); bumpSyncTick(); onRefresh() } catch (e) { alert(String(e)) }
  }

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      {/* Tool list */}
      <div style={{ width: 180, flexShrink: 0, borderRight: '1px solid #252d42', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
        <div style={{ padding: '10px 12px 6px', fontFamily: 'var(--lg-font-ui)', fontSize: 10, fontWeight: 600, color: '#4e5870', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          Git Tools
        </div>
        {TOOLS.map(t => (
          <ToolItem key={t.id} tool={t} active={activeTool === t.id} onClick={() => setActiveTool(t.id)} />
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ padding: '10px 12px', fontFamily: 'var(--lg-font-ui)', fontSize: 10, fontWeight: 600, color: '#4e5870', letterSpacing: '0.1em', textTransform: 'uppercase', borderTop: '1px solid #252d42' }}>
          Reference
        </div>
        <ToolItemPlain label="File History" icon="📋" onClick={() => setActiveTool('restore')} />
      </div>

      {/* Tool pane */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {activeTool === 'restore'    && <RestoreTool    repoPath={repoPath} run={run} />}
        {activeTool === 'revert'     && <RevertTool     repoPath={repoPath} run={run} />}
        {activeTool === 'cherrypick' && <CherryPickTool repoPath={repoPath} onRefresh={onRefresh} onConflict={onCherryPickConflict} />}
        {activeTool === 'reset'      && <ResetTool      repoPath={repoPath} run={run} />}
      </div>
    </div>
  )
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function ToolItem({ tool, active, onClick }: { tool: typeof TOOLS[number]; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 12px', textAlign: 'left', width: '100%',
        background: active ? 'rgba(232,98,47,0.12)' : hover ? '#1e2436' : 'transparent',
        border: 'none', borderLeft: `2px solid ${active ? '#e8622f' : 'transparent'}`,
        cursor: 'pointer', transition: 'background 0.1s',
      }}
    >
      <span style={{ fontSize: 14, width: 20, textAlign: 'center', flexShrink: 0 }}>{tool.icon}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, fontWeight: active ? 600 : 400, color: active ? '#dde1f0' : '#8b94b0', whiteSpace: 'nowrap' }}>
          {tool.label}
        </div>
      </div>
    </button>
  )
}

function ToolItemPlain({ label, icon, onClick }: { label: string; icon: string; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 12px', textAlign: 'left', width: '100%',
        background: hover ? '#1e2436' : 'transparent',
        border: 'none', cursor: 'pointer',
      }}
    >
      <span style={{ fontSize: 14, width: 20, textAlign: 'center' }}>{icon}</span>
      <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#8b94b0' }}>{label}</span>
    </button>
  )
}

function ToolHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <div style={{ padding: '14px 18px 10px', borderBottom: '1px solid #252d42', flexShrink: 0 }}>
      <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 15, fontWeight: 600, color: '#dde1f0', marginBottom: 4 }}>{title}</div>
      <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#4e5870' }}>{desc}</div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, fontWeight: 600, color: '#8b94b0', marginBottom: 4 }}>{label}</div>
      {hint && <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#4e5870', marginBottom: 6 }}>{hint}</div>}
      {children}
    </div>
  )
}

function TextInput({ value, onChange, placeholder, mono }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return (
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: '100%', boxSizing: 'border-box',
        background: '#10131c', border: '1px solid #252d42',
        borderRadius: 5, padding: '7px 10px',
        fontFamily: mono ? 'var(--lg-font-mono)' : 'var(--lg-font-ui)',
        fontSize: 12, color: '#dde1f0', outline: 'none',
      }}
      onFocus={e => (e.target.style.borderColor = '#e8622f')}
      onBlur={e => (e.target.style.borderColor = '#252d42')}
    />
  )
}

function ActionButton({ label, onClick, disabled, danger }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 34, paddingLeft: 16, paddingRight: 16, borderRadius: 6,
        background: danger
          ? (hover ? 'rgba(232,69,69,0.2)' : 'rgba(232,69,69,0.1)')
          : (hover ? 'rgba(232,98,47,0.25)' : 'rgba(232,98,47,0.15)'),
        border: `1px solid ${danger ? (hover ? '#e84545' : 'rgba(232,69,69,0.4)') : (hover ? '#e8622f' : 'rgba(232,98,47,0.4)')}`,
        color: danger ? '#e84545' : '#e8622f',
        fontFamily: 'var(--lg-font-ui)', fontSize: 13, fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'all 0.12s',
      }}
    >{label}</button>
  )
}

function CommitPicker({ repoPath, value, onChange, placeholder, onCommitSelect, sourceRef }: {
  repoPath: string; value: string; onChange: (v: string) => void; placeholder?: string
  onCommitSelect?: (c: CommitEntry) => void
  /** Optional ref (branch name) to load commits from. Defaults to HEAD. */
  sourceRef?: string
}) {
  const [commits, setCommits] = useState<CommitEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [showList, setShowList] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    setCommits([])
    setShowList(false)
  }, [sourceRef])

  const load = async () => {
    if (commits.length > 0) { setShowList(true); return }
    setLoading(true)
    try {
      const result = await ipc.log(repoPath, { limit: 200, refs: sourceRef ? [sourceRef] : undefined })
      setCommits(result)
      setShowList(true)
    } finally { setLoading(false) }
  }

  const filtered = query
    ? commits.filter(c => c.hash.startsWith(query) || c.message.toLowerCase().includes(query.toLowerCase()) || c.author.toLowerCase().includes(query.toLowerCase()))
    : commits

  const handleSelect = (c: CommitEntry) => {
    onChange(c.hash.slice(0, 8))
    setShowList(false)
    onCommitSelect?.(c)
  }

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={value}
          onChange={e => { onChange(e.target.value); setQuery(e.target.value) }}
          placeholder={placeholder ?? 'Commit hash or message…'}
          style={{
            flex: 1, background: '#10131c', border: '1px solid #252d42',
            borderRadius: 5, padding: '7px 10px',
            fontFamily: 'var(--lg-font-mono)', fontSize: 12, color: '#dde1f0', outline: 'none',
          }}
          onFocus={e => { e.target.style.borderColor = '#e8622f'; load() }}
          onBlur={e => { e.target.style.borderColor = '#252d42'; setTimeout(() => setShowList(false), 200) }}
        />
        <button
          onClick={load}
          style={{
            width: 34, height: 34, borderRadius: 5, flexShrink: 0,
            background: '#1d2235', border: '1px solid #252d42',
            color: '#8b94b0', cursor: 'pointer', fontSize: 16,
          }}
        >{loading ? '…' : '▾'}</button>
      </div>

      {showList && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: 38, left: 0, right: 0, zIndex: 50,
          background: '#1d2235', border: '1px solid #2f3a54',
          borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          maxHeight: 260, overflowY: 'auto',
        }}>
          {filtered.slice(0, 50).map(c => (
            <button
              key={c.hash}
              onMouseDown={() => handleSelect(c)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: '7px 12px', background: 'transparent', border: 'none',
                cursor: 'pointer', textAlign: 'left',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#242a3d')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#4d9dff', flexShrink: 0, width: 60 }}>{c.hash.slice(0, 7)}</span>
              <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#dde1f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{c.message}</span>
              <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#4e5870', flexShrink: 0 }}>{c.author.split(' ')[0]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Restore File Tool ──────────────────────────────────────────────────────────
// Flow: 1) pick commit → 2) pick file from that commit OR browse → 3) restore

function RestoreTool({ repoPath, run }: { repoPath: string; run: (label: string, fn: () => Promise<void>) => Promise<void> }) {
  const [step, setStep]             = useState<1 | 2>(1)
  const [hash, setHash]             = useState('')
  const [selectedCommit, setSelectedCommit] = useState<CommitEntry | null>(null)
  const [commitFiles, setCommitFiles]       = useState<{ status: string; path: string }[]>([])
  const [loadingFiles, setLoadingFiles]     = useState(false)
  const [selectedFile, setSelectedFile]     = useState('')
  const [customPath, setCustomPath]         = useState('')

  const targetPath = customPath || selectedFile

  const loadCommitFiles = async (commit: CommitEntry) => {
    setSelectedCommit(commit)
    setHash(commit.hash.slice(0, 8))
    setCommitFiles([])
    setSelectedFile('')
    setCustomPath('')
    setStep(2)
    setLoadingFiles(true)
    try {
      const files = await ipc.commitFiles(repoPath, commit.hash)
      setCommitFiles(files.filter(f => f.status !== 'D'))
    } finally { setLoadingFiles(false) }
  }

  const handleBrowse = async () => {
    const picked = await ipc.openFile(repoPath)
    if (!picked) return
    // Convert absolute path to relative
    const rel = picked.replace(/\\/g, '/').replace(repoPath.replace(/\\/g, '/') + '/', '')
    setCustomPath(rel)
    setSelectedFile('')
  }

  const doRestore = () => {
    if (!targetPath || !hash.trim()) return
    const commitLabel = selectedCommit ? `"${selectedCommit.message.slice(0, 50)}"` : hash.slice(0, 8)
    if (!confirm(`Restore "${targetPath}" to its state at commit ${commitLabel}?\n\nThis will overwrite your working-tree version.`)) return
    run('Restoring file…', () => ipc.gitRestoreFile(repoPath, targetPath, hash))
  }

  const S_COLOR: Record<string, string> = { M: '#f5a832', A: '#2ec573', R: '#4d9dff', C: '#4d9dff' }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <ToolHeader title="Restore File" desc="Bring a file back to its exact state from any past commit." />

      {/* Step indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '0 18px', borderBottom: '1px solid #252d42', flexShrink: 0 }}>
        {(['1. Pick commit', '2. Pick file'] as const).map((label, i) => {
          const s = i + 1
          const active = step === s
          const done = step > s
          return (
            <button key={s} onClick={() => s < step && setStep(s as 1 | 2)}
              style={{
                padding: '8px 14px', background: 'transparent', border: 'none',
                borderBottom: `2px solid ${active ? '#e8622f' : 'transparent'}`,
                color: active ? '#e8622f' : done ? '#2ec573' : '#4e5870',
                fontFamily: 'var(--lg-font-ui)', fontSize: 12, fontWeight: active ? 600 : 400,
                cursor: s < step ? 'pointer' : 'default', transition: 'all 0.12s',
              }}
            >{done ? '✓ ' : ''}{label}</button>
          )
        })}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 18px' }}>
        {step === 1 && (
          <>
            <Field label="Select a commit" hint="The file will be restored to its state at this point in history">
              <CommitPicker repoPath={repoPath} value={hash} onChange={setHash} onCommitSelect={loadCommitFiles} />
            </Field>
            <p style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#4e5870', marginTop: 8 }}>
              Select a commit from the dropdown to proceed to file selection.
            </p>
          </>
        )}

        {step === 2 && selectedCommit && (
          <>
            {/* Selected commit recap */}
            <div style={{ marginBottom: 16, padding: '10px 12px', background: '#161a27', border: '1px solid #252d42', borderRadius: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#4d9dff' }}>{selectedCommit.hash.slice(0, 8)}</span>
                <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#dde1f0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedCommit.message}</span>
                <button onClick={() => setStep(1)} style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#4e5870', background: 'none', border: 'none', cursor: 'pointer' }}>Change</button>
              </div>
            </div>

            {/* Files from commit */}
            <Field label="Files changed in this commit" hint="Click a file to select it, or browse for any file below">
              {loadingFiles ? (
                <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#4e5870' }}>Loading files…</div>
              ) : commitFiles.length === 0 ? (
                <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#4e5870' }}>No files found</div>
              ) : (
                <div style={{ border: '1px solid #252d42', borderRadius: 6, overflow: 'hidden', maxHeight: 240, overflowY: 'auto' }}>
                  {commitFiles.map(f => {
                    const sc    = S_COLOR[f.status] ?? '#8b94b0'
                    const isSelected = selectedFile === f.path && !customPath
                    return (
                      <button key={f.path} onClick={() => { setSelectedFile(f.path); setCustomPath('') }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                          padding: '8px 12px', background: isSelected ? '#242a3d' : 'transparent',
                          border: 'none', borderBottom: '1px solid #252d42', cursor: 'pointer', textAlign: 'left',
                        }}
                        onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = '#1e2436' }}
                        onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                      >
                        <span style={{ width: 18, height: 18, borderRadius: 3, flexShrink: 0, background: `${sc}22`, color: sc, fontFamily: 'var(--lg-font-mono)', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{f.status}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <FilePathText path={f.path} style={{ display: 'block', fontFamily: 'var(--lg-font-mono)', fontSize: 12, color: '#dde1f0' }} />
                        </div>
                        {isSelected && <span style={{ color: '#2ec573', fontSize: 14 }}>✓</span>}
                      </button>
                    )
                  })}
                </div>
              )}
            </Field>

            {/* OR browse */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{ flex: 1, height: 1, background: '#252d42' }} />
              <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#4e5870' }}>or browse for any file</span>
              <div style={{ flex: 1, height: 1, background: '#252d42' }} />
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              <div style={{ flex: 1, fontFamily: 'var(--lg-font-mono)', fontSize: 12, color: customPath ? '#dde1f0' : '#4e5870', padding: '7px 10px', background: '#10131c', border: '1px solid #252d42', borderRadius: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {customPath || 'No file selected'}
              </div>
              <button onClick={handleBrowse}
                style={{ height: 34, paddingLeft: 14, paddingRight: 14, borderRadius: 5, flexShrink: 0, background: '#1d2235', border: '1px solid #2f3a54', color: '#dde1f0', fontFamily: 'var(--lg-font-ui)', fontSize: 12, cursor: 'pointer' }}
              >Browse…</button>
            </div>

            {/* Action */}
            {targetPath && (
              <div style={{ padding: '10px 12px', background: 'rgba(232,98,47,0.06)', border: '1px solid rgba(232,98,47,0.2)', borderRadius: 6, marginBottom: 14 }}>
                <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#8b94b0', marginBottom: 2 }}>Will restore:</div>
                <FilePathText path={targetPath} style={{ display: 'block', fontFamily: 'var(--lg-font-mono)', fontSize: 12, color: '#e8622f' }} />
              </div>
            )}
            <ActionButton label="Restore File" disabled={!targetPath} onClick={doRestore} danger />
            <p style={{ marginTop: 10, fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#4e5870' }}>
              Equivalent to: <code style={{ fontFamily: 'var(--lg-font-mono)', color: '#8b94b0' }}>git checkout {hash} -- {targetPath || '<path>'}</code>
            </p>
          </>
        )}
      </div>
    </div>
  )
}

// ── Revert Commit Tool ────────────────────────────────────────────────────────

function RevertTool({ repoPath, run }: { repoPath: string; run: (label: string, fn: () => Promise<void>) => Promise<void> }) {
  const [hash, setHash]       = useState('')
  const [noCommit, setNoCommit] = useState(false)

  const doRevert = () => {
    if (!hash.trim()) return
    const staged = noCommit ? ' (staged only, no commit)' : ''
    if (!confirm(`Revert commit ${hash.slice(0, 8)}${staged}?`)) return
    run('Reverting commit…', () => ipc.gitRevert(repoPath, hash, noCommit))
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <ToolHeader title="Revert Commit" desc="Creates a new commit that is the inverse of the selected commit. Safe for shared history." />
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 18px' }}>
        <Field label="Commit to revert">
          <CommitPicker repoPath={repoPath} value={hash} onChange={setHash} />
        </Field>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <Toggle checked={noCommit} onChange={setNoCommit} />
          <div>
            <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#dde1f0' }}>Stage only, don't commit</div>
            <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#4e5870' }}>Lets you review or amend before committing</div>
          </div>
        </div>

        <ActionButton label={noCommit ? 'Stage Revert' : 'Revert & Commit'} disabled={!hash.trim()} onClick={doRevert} />
        <p style={{ marginTop: 10, fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#4e5870' }}>
          Equivalent to: <code style={{ fontFamily: 'var(--lg-font-mono)', color: '#8b94b0' }}>git revert {hash || '<hash>'}{noCommit ? ' --no-commit' : ''}</code>
        </p>
      </div>
    </div>
  )
}

// ── Cherry-pick Tool ──────────────────────────────────────────────────────────

function CherryPickTool({ repoPath, onRefresh, onConflict }: {
  repoPath: string
  onRefresh: () => void
  onConflict?: () => void
}) {
  const [hash, setHash] = useState('')
  const [sourceRef, setSourceRef] = useState<string>('')   // empty = current branch (HEAD)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const dialog = useDialogStore()
  const opRun = useOperationStore(s => s.run)
  const bumpSyncTick = useRepoStore(s => s.bumpSyncTick)

  useEffect(() => {
    ipc.branchList(repoPath).then(setBranches).catch(() => {})
  }, [repoPath])

  const doPick = async () => {
    if (!hash.trim()) return
    const ok = await dialog.confirm({
      title: 'Cherry-pick commit',
      message: `Apply commit ${hash.slice(0, 8)} onto your current branch?`,
      detail: sourceRef ? `Source branch: ${sourceRef}` : undefined,
      confirmLabel: 'Cherry-pick',
    })
    if (!ok) return
    try {
      await opRun('Cherry-picking…', () => ipc.gitCherryPick(repoPath, hash))
      bumpSyncTick()
      onRefresh()
    } catch (e) {
      // Cherry-pick may have left CHERRY_PICK_HEAD — if so, it's a recoverable
      // conflict we can resolve via the dialog. Otherwise it's a real error.
      const inProgress = await ipc.cherryPickInProgress(repoPath).catch(() => null)
      if (inProgress && onConflict) {
        onConflict()
      } else {
        alert(String(e))
      }
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <ToolHeader title="Cherry-pick" desc="Apply changes from a single commit to your current branch without merging the full branch." />
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 18px' }}>
        <Field label="Source branch" hint="Browse commits from any local or remote branch">
          <BranchPicker branches={branches} value={sourceRef} onChange={ref => { setSourceRef(ref); setHash('') }} />
        </Field>
        <Field label="Commit to cherry-pick">
          <CommitPicker repoPath={repoPath} value={hash} onChange={setHash} sourceRef={sourceRef || undefined} />
        </Field>
        <ActionButton label="Cherry-pick" disabled={!hash.trim()} onClick={doPick} />
        <p style={{ marginTop: 10, fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#4e5870' }}>
          Equivalent to: <code style={{ fontFamily: 'var(--lg-font-mono)', color: '#8b94b0' }}>git cherry-pick {hash || '<hash>'}</code>
        </p>

        <div style={{ marginTop: 24, padding: 14, background: 'rgba(77,157,255,0.06)', border: '1px solid rgba(77,157,255,0.2)', borderRadius: 6 }}>
          <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#4d9dff', fontWeight: 600, marginBottom: 4 }}>Note</div>
          <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#8b94b0', lineHeight: 1.6 }}>
            If the cherry-pick causes conflicts, resolve them in the Changes panel and commit manually.
            Run <code style={{ fontFamily: 'var(--lg-font-mono)' }}>git cherry-pick --abort</code> in a terminal to cancel.
          </div>
        </div>
      </div>
    </div>
  )
}

function BranchPicker({ branches, value, onChange }: {
  branches: BranchInfo[]
  value: string
  onChange: (ref: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  // Sort: current branch first, then locals (alpha), then remote-only (alpha).
  const sorted = [...branches].sort((a, b) => {
    if (a.current && !b.current) return -1
    if (b.current && !a.current) return 1
    if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1
    return a.name.localeCompare(b.name)
  }).filter(b => !(b.isRemote && b.hasLocal))   // hide remote duplicates of locals

  const filtered = query
    ? sorted.filter(b => b.name.toLowerCase().includes(query.toLowerCase()))
    : sorted

  const selected = branches.find(b => b.name === value)
  const label = selected
    ? selected.name
    : value
      ? value
      : (branches.find(b => b.current)?.name ?? 'Current branch (HEAD)')

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          background: '#10131c', border: '1px solid #252d42',
          borderRadius: 5, padding: '7px 10px',
          fontFamily: 'var(--lg-font-mono)', fontSize: 12, color: '#dde1f0',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {selected?.isRemote && (
          <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#4d9dff', textTransform: 'uppercase', letterSpacing: '0.06em' }}>remote</span>
        )}
        <span style={{ color: '#8b94b0', fontSize: 14 }}>▾</span>
      </button>

      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 49 }}
          />
          <div style={{
            position: 'absolute', top: 38, left: 0, right: 0, zIndex: 50,
            background: '#1d2235', border: '1px solid #2f3a54',
            borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            maxHeight: 300, display: 'flex', flexDirection: 'column',
          }}>
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Filter branches…"
              autoFocus
              style={{
                background: '#10131c', border: 'none', borderBottom: '1px solid #252d42',
                padding: '8px 10px', fontFamily: 'var(--lg-font-ui)', fontSize: 12,
                color: '#dde1f0', outline: 'none',
              }}
            />
            <div style={{ overflowY: 'auto' }}>
              <button
                onMouseDown={() => { onChange(''); setOpen(false); setQuery('') }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '7px 12px', background: value === '' ? '#242a3d' : 'transparent',
                  border: 'none', borderBottom: '1px solid #252d42', cursor: 'pointer', textAlign: 'left',
                }}
                onMouseEnter={e => { if (value !== '') e.currentTarget.style.background = '#242a3d' }}
                onMouseLeave={e => { if (value !== '') e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#dde1f0', flex: 1 }}>Current branch (HEAD)</span>
              </button>
              {filtered.length === 0 ? (
                <div style={{ padding: '10px 12px', fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#4e5870' }}>No branches match</div>
              ) : filtered.map(b => {
                const isSelected = b.name === value
                return (
                  <button
                    key={b.name}
                    onMouseDown={() => { onChange(b.name); setOpen(false); setQuery('') }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                      padding: '7px 12px', background: isSelected ? '#242a3d' : 'transparent',
                      border: 'none', cursor: 'pointer', textAlign: 'left',
                    }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = '#242a3d' }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                  >
                    <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 12, color: b.current ? '#2ec573' : '#dde1f0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {b.name}
                    </span>
                    {b.current && (
                      <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#2ec573', textTransform: 'uppercase', letterSpacing: '0.06em' }}>current</span>
                    )}
                    {b.isRemote && (
                      <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#4d9dff', textTransform: 'uppercase', letterSpacing: '0.06em' }}>remote</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Reset Tool ────────────────────────────────────────────────────────────────

const RESET_MODES: { mode: 'soft' | 'mixed' | 'hard'; label: string; desc: string; color: string }[] = [
  { mode: 'soft',  label: 'Soft',  desc: 'Move HEAD only. Staged changes are preserved.',             color: '#2ec573' },
  { mode: 'mixed', label: 'Mixed', desc: 'Move HEAD and unstage changes. Working tree untouched.',    color: '#f5a832' },
  { mode: 'hard',  label: 'Hard',  desc: 'Move HEAD and discard all changes. Cannot be undone easily.', color: '#e84545' },
]

function ResetTool({ repoPath, run }: { repoPath: string; run: (label: string, fn: () => Promise<void>) => Promise<void> }) {
  const [hash, setHash]   = useState('')
  const [mode, setMode]   = useState<'soft' | 'mixed' | 'hard'>('mixed')

  const doReset = () => {
    if (!hash.trim()) return
    const m = RESET_MODES.find(r => r.mode === mode)!
    const warn = mode === 'hard' ? '\n\n⚠️  HARD reset will discard ALL uncommitted changes. This cannot be easily undone.' : ''
    if (!confirm(`Reset HEAD to ${hash.slice(0, 8)} (--${mode})?${warn}`)) return
    run(`Resetting (--${mode})…`, () => ipc.gitResetTo(repoPath, hash, mode))
  }

  const selectedMode = RESET_MODES.find(r => r.mode === mode)!

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <ToolHeader title="Reset to Commit" desc="Move HEAD (and optionally staged/working-tree changes) to a past commit." />
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 18px' }}>
        <Field label="Target commit">
          <CommitPicker repoPath={repoPath} value={hash} onChange={setHash} />
        </Field>

        <Field label="Reset mode">
          <div style={{ display: 'flex', gap: 6 }}>
            {RESET_MODES.map(r => (
              <button
                key={r.mode}
                onClick={() => setMode(r.mode)}
                style={{
                  flex: 1, height: 32, borderRadius: 6,
                  background: mode === r.mode ? `${r.color}22` : 'transparent',
                  border: `1px solid ${mode === r.mode ? r.color : '#252d42'}`,
                  color: mode === r.mode ? r.color : '#8b94b0',
                  fontFamily: 'var(--lg-font-ui)', fontSize: 12, fontWeight: mode === r.mode ? 600 : 400,
                  cursor: 'pointer', transition: 'all 0.12s',
                }}
              >{r.label}</button>
            ))}
          </div>
          <div style={{ marginTop: 8, fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#4e5870' }}>
            {selectedMode.desc}
          </div>
        </Field>

        <ActionButton label={`Reset --${mode}`} disabled={!hash.trim()} onClick={doReset} danger={mode === 'hard'} />
        <p style={{ marginTop: 10, fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#4e5870' }}>
          Equivalent to: <code style={{ fontFamily: 'var(--lg-font-mono)', color: '#8b94b0' }}>git reset --{mode} {hash || '<hash>'}</code>
        </p>
      </div>
    </div>
  )
}

// ── Reusable toggle ────────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        width: 32, height: 18, borderRadius: 9, flexShrink: 0,
        background: checked ? '#2ec573' : '#252d42',
        border: 'none', padding: 0, cursor: 'pointer',
        position: 'relative', transition: 'background 0.2s',
      }}
    >
      <span style={{
        position: 'absolute', top: 3, width: 12, height: 12,
        borderRadius: '50%', background: '#fff',
        transition: 'left 0.2s', left: checked ? 17 : 3,
      }} />
    </button>
  )
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BranchDiffCommit, ipc } from '@/ipc'
import { usePRStore } from '@/stores/prStore'
import { useRepoStore } from '@/stores/repoStore'
import { useLockStore } from '@/stores/lockStore'
import { useAuthStore } from '@/stores/authStore'
import { useStatusToastStore } from '@/stores/statusToastStore'
import { ActionBtn } from '@/components/ui/ActionBtn'
import { useDialogOverlayDismiss } from '@/lib/useDialogOverlayDismiss'

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseGitHubSlug(url: string): string | null {
  const m = url.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)
  return m ? m[1] : null
}

function branchToTitle(branch: string): string {
  const stripped = branch.replace(/^(feature|feat|fix|chore|hotfix|release|refactor|docs|style|test|build|ci|perf)\//i, '')
  return stripped
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim()
}

function normalizeBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '').replace(/^origin\//, '')
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase = 'form' | 'submitting' | 'success' | 'error'

// ── Styled primitives ─────────────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: 'var(--lg-font-ui)', fontSize: 11, fontWeight: 600,
      color: '#5a6880', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6,
    }}>
      {children}
    </div>
  )
}

function TextInput({ value, onChange, placeholder, disabled, autoFocus }: {
  value: string; onChange: (v: string) => void; placeholder?: string
  disabled?: boolean; autoFocus?: boolean
}) {
  const [focus, setFocus] = useState(false)
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{
        width: '100%', boxSizing: 'border-box',
        background: '#0d1117', border: `1px solid ${focus ? '#4a9eff66' : '#1e2a3d'}`,
        borderRadius: 6, padding: '7px 10px',
        fontFamily: 'var(--lg-font-ui)', fontSize: 13, color: '#c8d0e8',
        outline: 'none', transition: 'border-color 0.15s',
        opacity: disabled ? 0.5 : 1,
      }}
    />
  )
}

function TextArea({ value, onChange, placeholder, disabled, rows = 4 }: {
  value: string; onChange: (v: string) => void; placeholder?: string
  disabled?: boolean; rows?: number
}) {
  const [focus, setFocus] = useState(false)
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      rows={rows}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{
        width: '100%', boxSizing: 'border-box', resize: 'vertical',
        background: '#0d1117', border: `1px solid ${focus ? '#4a9eff66' : '#1e2a3d'}`,
        borderRadius: 6, padding: '7px 10px',
        fontFamily: 'var(--lg-font-ui)', fontSize: 13, color: '#c8d0e8',
        outline: 'none', transition: 'border-color 0.15s',
        opacity: disabled ? 0.5 : 1, lineHeight: 1.6,
      }}
    />
  )
}

function SelectInput({ value, onChange, options, disabled }: {
  value: string; onChange: (v: string) => void
  options: string[]; disabled?: boolean
}) {
  const [focus, setFocus] = useState(false)
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{
        background: '#0d1117', border: `1px solid ${focus ? '#4a9eff66' : '#1e2a3d'}`,
        borderRadius: 6, padding: '7px 10px',
        fontFamily: 'var(--lg-font-ui)', fontSize: 13, color: '#c8d0e8',
        outline: 'none', cursor: 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}

function Btn({ label, onClick, disabled, primary, danger }: {
  label: string; onClick: () => void; disabled?: boolean; primary?: boolean; danger?: boolean
}) {
  const color = danger ? '#e84545' : primary ? '#a78bfa' : undefined
  return (
    <ActionBtn
      onClick={onClick}
      disabled={disabled}
      color={color}
      ghost={!primary && !danger}
      style={{ height: 32, paddingLeft: 16, paddingRight: 16, fontSize: 12.5, fontWeight: 600 }}
    >{label}</ActionBtn>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function PRDialog() {
  const { open, repoPath, headBranch, remoteUrl, closeDialog } = usePRStore()
  const branches                     = useRepoStore(s => s.branches)
  const bumpPrTick                   = useRepoStore(s => s.bumpPrTick)
  const { locks }                    = useLockStore()
  const { accounts, currentAccountId } = useAuthStore()
  const showStatusToast = useStatusToastStore(s => s.show)
  const currentLogin = accounts.find(a => a.userId === currentAccountId)?.login ?? null

  const [title, setTitle]   = useState('')
  const [body, setBody]     = useState('')
  const [base, setBase]     = useState('main')
  const [draft, setDraft]   = useState(false)
  const [phase, setPhase]   = useState<Phase>('form')
  const [error, setError]   = useState<string | null>(null)
  const [result, setResult] = useState<{ number: number; htmlUrl: string; title: string } | null>(null)
  const [mergeCommits, setMergeCommits] = useState<BranchDiffCommit[]>([])
  const [preview, setPreview] = useState<{ key: string; state: 'loading' | 'ready' | 'error'; error?: string }>({ key: '', state: 'loading' })
  const [previewRetry, setPreviewRetry] = useState(0)
  const [publishing, setPublishing] = useState(false)
  const touched = useRef({ title: false, body: false, base: false })
  const submitting = useRef(false)
  const requestClose = useCallback(() => { if (!submitting.current) closeDialog() }, [closeDialog])

  const slug  = remoteUrl ? parseGitHubSlug(remoteUrl) : null
  const parts = slug ? slug.split('/') : []
  const owner = parts[0] ?? ''
  const repo  = parts[1] ?? ''

  const normalizedHead = headBranch ? normalizeBranchName(headBranch) : ''
  const normalizedBase = normalizeBranchName(base)
  const previewKey = JSON.stringify([repoPath, owner, repo, normalizedBase, normalizedHead, currentAccountId])
  const previewReady = preview.key === previewKey && preview.state === 'ready'
  const activePreviewKey = useRef(previewKey)
  activePreviewKey.current = previewKey
  const selectableBranches = Array.from(new Set(
    branches
      .map(b => normalizeBranchName(b.displayName || b.name))
      .filter(name => name && name !== normalizedHead)
  ))

  // Build the base branch options: always put default branch first
  const baseOptions = Array.from(new Set([
    normalizeBranchName(base || 'main'),
    ...selectableBranches,
  ])).filter(name => name && name !== normalizedHead)

  useEffect(() => {
    if (!open || !repoPath || !headBranch) return
    let cancelled = false
    touched.current = { title: false, body: false, base: false }
    setTitle(branchToTitle(normalizeBranchName(headBranch)))
    setBody('')
    setDraft(false)
    setPhase('form')
    setError(null)
    setResult(null)

    ipc.gitDefaultBranch(repoPath)
      .then(def => { if (!cancelled && !touched.current.base && !submitting.current) setBase(def) })
      .catch(() => { if (!cancelled && !touched.current.base && !submitting.current) setBase('main') })
    return () => { cancelled = true }
  }, [open, repoPath, headBranch])

  useEffect(() => {
    if (!open || !repoPath || !headBranch || !base || !owner || !repo) {
      setMergeCommits([])
      return
    }

    let cancelled = false
    setMergeCommits([])
    setPreview({ key: previewKey, state: 'loading' })
    if (!touched.current.body && !submitting.current) setBody('')
    ipc.githubComparePR({ owner, repo, base: normalizedBase, head: normalizedHead })
      .then(commits => {
        if (cancelled) return
        setMergeCommits(commits)
        setPreview({ key: previewKey, state: 'ready' })
        if (commits.length > 0) {
          const firstMeaningful = commits.find(c => !c.message.includes('Merge remote-tracking branch'))
          if (!touched.current.title && !submitting.current) setTitle((firstMeaningful ?? commits[0]).message)
          if (!touched.current.body && !submitting.current) setBody(commits.map(c => `- ${c.message}`).join('\n'))
        }
      })
      .catch(error => {
        if (!cancelled) {
          setMergeCommits([])
          setPreview({ key: previewKey, state: 'error', error: String(error) })
        }
      })

    return () => { cancelled = true }
  }, [open, repoPath, headBranch, base, owner, repo, normalizedBase, normalizedHead, previewKey, previewRetry])

  const commitCountLabel = useMemo(() => (
    mergeCommits.length === 1 ? '1 commit' : `${mergeCommits.length} commits`
  ), [mergeCommits])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, requestClose])

  const overlayDismiss = useDialogOverlayDismiss(requestClose)

  const publishBranch = async () => {
    if (!repoPath || !remoteUrl || !normalizedHead || submitting.current) return
    submitting.current = true
    setPublishing(true)
    try {
      await ipc.publishPRBranch(repoPath, normalizedHead, remoteUrl)
      if (activePreviewKey.current === previewKey) setPreviewRetry(value => value + 1)
    } catch (error) {
      if (activePreviewKey.current === previewKey) setPreview({ key: previewKey, state: 'error', error: String(error) })
    } finally {
      submitting.current = false
      setPublishing(false)
    }
  }

  if (!open) return null

  const canSubmit = title.trim().length > 0 && owner && repo && base && phase === 'form' && !publishing && previewReady && mergeCommits.length > 0

  const submit = async () => {
    if (!canSubmit || !headBranch || submitting.current) return
    submitting.current = true
    setPhase('submitting')
    setError(null)
    try {
      const res = await ipc.githubCreatePR({
        owner,
        repo,
        head: normalizeBranchName(headBranch),
        base: normalizeBranchName(base || 'main'),
        title: title.trim(),
        body,
        draft,
      })
      setResult(res)
      setPhase('success')
      bumpPrTick()
      showStatusToast('PR created successfully.')
      // Associate currently-locked files with this PR so we can prompt to unlock on merge
      if (repoPath) {
        const myLockedFiles = locks
          .filter(l => l.owner.login === currentLogin)
          .map(l => l.path)
        ipc.prMonitorRecord(repoPath, res.number, owner, repo, myLockedFiles, title.trim()).catch(() => {})
      }
    } catch (e) {
      showStatusToast('PR creation failed.')
      setError(String(e).replace(/^Error:\s*/, ''))
      setPhase('error')
    } finally {
      submitting.current = false
    }
  }

  const busy = phase === 'submitting' || publishing

  return (
    <div
      {...overlayDismiss}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--lg-font-ui)',
      }}
    >
      <div style={{
        width: 980, maxWidth: '96vw', background: '#131720',
        border: '1px solid #1e2a3d', borderRadius: 12,
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        overflow: 'hidden',
      }}>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: '1px solid #18202e',
          background: 'rgba(0,0,0,0.15)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <PRIcon />
            <span style={{ fontSize: 14, fontWeight: 700, color: '#c8d0e8', letterSpacing: '-0.02em' }}>
              {phase === 'success' ? 'Pull Request Created' : 'Create Pull Request'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {slug && (
              <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#344057' }}>
                {slug}
              </span>
            )}
            <button
              className="lg-compact-icon-button"
              onClick={requestClose}
              disabled={busy}
              style={{
                width: 22, height: 22, borderRadius: 5, border: 'none',
                background: 'transparent', color: '#4a566a', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
              }}
              onMouseEnter={e => { e.currentTarget.style.color = '#c8d0e8'; e.currentTarget.style.background = '#1e2a3d' }}
              onMouseLeave={e => { e.currentTarget.style.color = '#4a566a'; e.currentTarget.style.background = 'transparent' }}
            >×</button>
          </div>
        </div>

        {/* Body */}
        {phase === 'success' && result ? (
          <SuccessView result={result} onClose={closeDialog} />
        ) : (
          <div style={{ padding: '20px 20px 18px', display: 'flex', gap: 18 }}>
            <div style={{ flex: 1, minWidth: 0 }}>

            {/* Branch row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
              <BranchChip label={headBranch ?? ''} color="#a78bfa" />
              <span style={{ color: '#283047', fontSize: 13 }}>→</span>
              <SelectInput
                value={base}
                onChange={value => { touched.current.base = true; setBase(value) }}
                options={baseOptions}
                disabled={busy}
              />
            </div>

            {/* Title */}
            <div style={{ marginBottom: 14 }}>
              <Label>Title</Label>
              <TextInput
                value={title}
                onChange={value => { touched.current.title = true; setTitle(value) }}
                placeholder="PR title"
                disabled={busy}
                autoFocus
              />
            </div>

            {/* Body */}
            <div style={{ marginBottom: 16 }}>
              <Label>Description <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: '#283047' }}>— optional</span></Label>
              <TextArea
                value={body}
                onChange={value => { touched.current.body = true; setBody(value) }}
                placeholder="What does this PR do? Why is it needed?"
                disabled={busy}
                rows={4}
              />
            </div>

            {/* Draft toggle */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: busy ? 'default' : 'pointer', marginBottom: 20, userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={draft}
                onChange={e => setDraft(e.target.checked)}
                disabled={busy}
                style={{ accentColor: '#e8622f', width: 14, height: 14, cursor: busy ? 'default' : 'pointer' }}
              />
              <span style={{ fontSize: 12.5, color: draft ? '#c8d0e8' : '#5a6880' }}>Open as draft</span>
            </label>

            {/* Error */}
            {phase === 'error' && error && (
              <div style={{
                marginBottom: 14, padding: '9px 12px', borderRadius: 6,
                background: 'rgba(232,69,69,0.08)', border: '1px solid rgba(232,69,69,0.25)',
                fontSize: 12, color: '#e84545', lineHeight: 1.5,
              }}>
                {error}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Btn label="Cancel" onClick={requestClose} disabled={busy} />
              <Btn
                label={publishing ? 'Pushing branch…' : busy ? 'Creating…' : phase === 'error' ? 'Try Again' : 'Create Pull Request'}
                onClick={phase === 'error' ? () => { setPhase('form'); setError(null) } : submit}
                disabled={busy || (!canSubmit && phase !== 'error')}
                primary
              />
            </div>
            </div>

            <div style={{
              width: 320, flexShrink: 0,
              border: '1px solid #1e2a3d', borderRadius: 8,
              background: '#0f141d', padding: 12,
              alignSelf: 'stretch',
            }}>
              <Label>Commits proposed for merge</Label>
              <div style={{ fontSize: 12, color: '#5a6880', marginBottom: 10 }}>
                Published {normalizedHead} → {normalizedBase}{previewReady ? ` · ${commitCountLabel}` : ''}
              </div>
              {preview.key === previewKey && preview.state === 'error' ? (
                <div role="alert" style={{ fontSize: 12, color: '#e84545' }}>
                  Could not compare the published branches. {preview.error?.replace('PR_HEAD_NOT_PUBLISHED: ', '')}
                  {preview.error?.includes('PR_HEAD_NOT_PUBLISHED:') && (
                    <Btn label={publishing ? 'Pushing branch…' : 'Push branch and retry'} onClick={publishBranch} disabled={busy || publishing} />
                  )}
                  <Btn label="Retry preview" onClick={() => setPreviewRetry(value => value + 1)} disabled={busy || publishing} />
                </div>
              ) : !previewReady ? (
                <div role="status" style={{ fontSize: 12, color: '#5a6880' }}>Loading published commits…</div>
              ) : mergeCommits.length === 0 ? (
                <div style={{ fontSize: 12, color: '#5a6880' }}>No published commits are missing from {normalizedBase}.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 300, overflowY: 'auto', paddingRight: 2 }}>
                  {mergeCommits.map(commit => (
                    <div
                      key={commit.hash}
                      style={{
                        border: '1px solid #1b2433', borderRadius: 6,
                        padding: '8px 9px', background: '#111722',
                      }}
                    >
                      <div style={{ fontSize: 12.5, color: '#c8d0e8', lineHeight: 1.35 }}>{commit.message}</div>
                      <div style={{ marginTop: 4, fontSize: 10.5, color: '#4a566a', fontFamily: 'var(--lg-font-mono)' }}>
                        {commit.hash.slice(0, 7)} · {commit.author}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Success view ──────────────────────────────────────────────────────────────

function SuccessView({ result, onClose }: {
  result: { number: number; htmlUrl: string; title: string }
  onClose: () => void
}) {
  return (
    <div style={{ padding: '28px 24px 22px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <div style={{
        width: 40, height: 40, borderRadius: '50%',
        background: 'rgba(45,189,110,0.12)', border: '1.5px solid rgba(45,189,110,0.3)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 20, color: '#2dbd6e', marginBottom: 6,
      }}>✓</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#c8d0e8' }}>
        PR #{result.number} opened
      </div>
      <div style={{
        fontSize: 12, color: '#5a6880', maxWidth: 380,
        textAlign: 'center', lineHeight: 1.5, marginBottom: 6,
      }}>
        {result.title}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <Btn label="Close" onClick={onClose} />
        <Btn
          label="View on GitHub ↗"
          onClick={() => ipc.openExternal(result.htmlUrl)}
          primary
        />
      </div>
    </div>
  )
}

// ── Branch chip ───────────────────────────────────────────────────────────────

function BranchChip({ label, color }: { label: string; color: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5,
      background: `${color}14`, border: `1px solid ${color}33`,
      borderRadius: 5, padding: '4px 9px', flexShrink: 0,
    }}>
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ color }}>
        <circle cx="5" cy="4" r="2" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="5" cy="12" r="2" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="11" cy="4" r="2" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5 6v4M5 6C5 9 11 7 11 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span style={{
        fontFamily: 'var(--lg-font-mono)', fontSize: 11, color,
        maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{label}</span>
    </div>
  )
}

// ── Icon ──────────────────────────────────────────────────────────────────────

function PRIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ color: '#a78bfa', flexShrink: 0 }}>
      <circle cx="4"  cy="4"  r="1.8" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4"  cy="12" r="1.8" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="4"  r="1.8" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 5.8v4.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M12 5.8C12 9 7 10 4 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

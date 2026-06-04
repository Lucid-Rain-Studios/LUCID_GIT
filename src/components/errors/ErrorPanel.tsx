import React, { useState } from 'react'
import { ipc } from '@/ipc'
import { useErrorStore } from '@/stores/errorStore'
import { useRepoStore } from '@/stores/repoStore'
import { LucidGitError, FixStep, FixAction } from '@/lib/gitErrors'
import { cn } from '@/lib/utils'
import { ActionBtn } from '@/components/ui/ActionBtn'

interface ErrorPanelProps {
  onReauth: () => void
  onNavigateTab: (tab: string) => void
  onOpenMergeResolver: () => void | Promise<void>
}

export function ErrorPanel({ onReauth, onNavigateTab, onOpenMergeResolver }: ErrorPanelProps) {
  const { current, history, dismiss, clearHistory } = useErrorStore()
  const { repoPath, currentBranch } = useRepoStore()

  const [showHistory, setShowHistory] = useState(false)
  const [autoFixBusy, setAutoFixBusy] = useState(false)
  const [autoFixResult, setAutoFixResult] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // Reset local state when the displayed error changes
  const handleDismiss = () => {
    setAutoFixResult(null)
    dismiss()
  }

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 1500)
  }

  const dispatch = async (action: FixAction) => {
    if (!repoPath) return
    setAutoFixBusy(true)
    setAutoFixResult(null)
    try {
      switch (action.type) {
        case 'reauth':
          handleDismiss()
          onReauth()
          break

        case 'open-conflict-resolver':
          handleDismiss()
          // The conflict resolver lives in the MergePreviewDialog, not on
          // the Branches tab — opening it directly avoids a confusing detour
          // where the user has to re-pull just to get the dialog to appear.
          await onOpenMergeResolver()
          break

        case 'run-lfs-migrate':
          await ipc.lfsMigrate(repoPath, action.patterns.length ? action.patterns : ['*.uasset', '*.umap'])
          setAutoFixResult('LFS migration complete. Force-push required.')
          break

        case 'open-settings':
          handleDismiss()
          onNavigateTab('settings')
          break

        case 'set-upstream':
          await ipc.setUpstream(repoPath, currentBranch ?? action.branch)
          setAutoFixResult('Upstream set and branch pushed.')
          break

        case 'abort-rebase':
          await ipc.rebaseAbort(repoPath)
          setAutoFixResult('Rebase aborted.')
          handleDismiss()
          break

        case 'clean-pack-files':
          await ipc.cleanupGc(repoPath, false)
          setAutoFixResult('Git GC complete.')
          break

        case 'increase-buffer':
          await ipc.setGitConfig(repoPath, 'http.postBuffer', '524288000')
          setAutoFixResult('HTTP buffer set to 500 MB. Retry your push.')
          break

        case 'retry-with-ssh':
          setAutoFixResult('Switch the remote URL to SSH:\n  git remote set-url origin git@github.com:org/repo.git')
          break

        case 'clear-lock-cache': {
          const locks = await ipc.clearLockCache(repoPath)
          setAutoFixResult(`Lock cache cleared — ${locks.length} lock${locks.length !== 1 ? 's' : ''} refreshed from the server.`)
          break
        }
      }
    } catch (e) {
      setAutoFixResult(`Fix failed: ${String(e)}`)
    } finally {
      setAutoFixBusy(false)
    }
  }

  const accent = (s: LucidGitError['severity']) => (s === 'warning' ? '#f5a623' : '#e84040')
  const severityLabel = (s: LucidGitError['severity']) =>
    s === 'fatal' ? 'FATAL' : s === 'error' ? 'ERROR' : 'WARNING'

  if (!current && !showHistory) return null

  return (
    <>
      {/* ── Overlay backdrop for history panel ── */}
      {showHistory && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setShowHistory(false)}
        />
      )}

      {/* ── Slide-up error panel ── */}
      {current && (() => {
        const c = accent(current.severity)
        return (
        <div
          style={{
            position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
            zIndex: 50, width: 600, maxWidth: 'calc(100vw - 32px)',
            background: '#12161f',                 // fully opaque surface
            border: `1px solid ${c}`,
            borderTop: `3px solid ${c}`,           // bold severity accent
            borderRadius: 10,
            boxShadow: '0 24px 64px rgba(0,0,0,0.7), 0 4px 16px rgba(0,0,0,0.5)',
            fontFamily: 'var(--lg-font-ui)',
            overflow: 'hidden',
            animation: 'slide-down 0.16s ease both',
          }}
        >
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 9,
            padding: '11px 14px', background: `${c}1f`, borderBottom: '1px solid #1d2535',
          }}>
            <ErrorGlyph color={c} severity={current.severity} />
            <span style={{
              fontFamily: 'var(--lg-font-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
              color: c, background: `${c}26`, border: `1px solid ${c}66`,
              borderRadius: 4, padding: '2px 6px', flexShrink: 0,
            }}>
              {severityLabel(current.severity)} · {current.code}
            </span>
            <span style={{ flex: 1, fontSize: 13.5, fontWeight: 700, color: '#eef2fb', letterSpacing: '-0.01em' }}>
              {current.title}
            </span>
            <HeaderBtn label={copied === 'all' ? '✓ Copied' : 'Copy'} title="Copy full error"
              onClick={() => copyToClipboard(`${current.title}\n\n${current.description}\n\n${current.gitMessage}`, 'all')} />
            <HeaderBtn label="✕" title="Dismiss" onClick={handleDismiss} />
          </div>

          {/* Body */}
          <div style={{ padding: '13px 14px', display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 'min(60vh, 460px)', overflowY: 'auto' }}>
            {/* Plain-language description */}
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: '#d6deef' }}>
              {current.description}
            </p>

            {/* Raw output — always visible so you never need Bug Logs */}
            <div>
              <SectionHeading>What git reported</SectionHeading>
              <pre style={{
                margin: 0, maxHeight: 150, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                background: '#0b0d13', border: '1px solid #1d2535', borderRadius: 6,
                padding: '9px 10px', fontFamily: 'var(--lg-font-mono)', fontSize: 11, lineHeight: 1.55,
                color: '#c2ccdf',
              }}>
                {current.gitMessage?.trim() || '(no output captured)'}
              </pre>
            </div>

            {/* Likely causes */}
            {current.causes.length > 0 && (
              <div>
                <SectionHeading>Likely causes</SectionHeading>
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {current.causes.map((cause, i) => (
                    <li key={i} style={{ display: 'flex', gap: 8, fontSize: 12, lineHeight: 1.5, color: '#aab4ca' }}>
                      <span style={{ color: c, flexShrink: 0 }}>•</span>
                      <span>{cause}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Fixes */}
            {current.fixes.length > 0 && (
              <div>
                <SectionHeading>How to fix it</SectionHeading>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {current.fixes.map((step, i) => (
                    <FixRow key={i} step={step} busy={autoFixBusy} copied={copied} onDispatch={dispatch} onCopy={copyToClipboard} />
                  ))}
                </div>
              </div>
            )}

            {/* Auto-fix result */}
            {autoFixResult && (
              <pre style={{
                margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'var(--lg-font-mono)', fontSize: 11,
                color: '#6fcf97', background: 'rgba(45,189,110,0.08)', border: '1px solid rgba(45,189,110,0.25)',
                borderRadius: 6, padding: '8px 10px',
              }}>
                {autoFixResult}
              </pre>
            )}
          </div>

          {/* Footer */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 14px', borderTop: '1px solid #1d2535', background: 'rgba(0,0,0,0.18)' }}>
            <button
              onClick={() => setShowHistory(true)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#7b8499' }}
              onMouseEnter={e => (e.currentTarget.style.color = '#c8d0e8')}
              onMouseLeave={e => (e.currentTarget.style.color = '#7b8499')}
            >
              Error history ({history.length})
            </button>
            {current.docsUrl && (
              <button
                onClick={() => ipc.openExternal(current.docsUrl!)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#7b8499' }}
                onMouseEnter={e => (e.currentTarget.style.color = '#c8d0e8')}
                onMouseLeave={e => (e.currentTarget.style.color = '#7b8499')}
              >
                Documentation ↗
              </button>
            )}
          </div>
        </div>
        )
      })()}

      {/* ── Error history panel ── */}
      {showHistory && (
        <div className="fixed bottom-0 left-0 right-0 z-50 bg-lg-bg-elevated border-t border-lg-border max-h-64 overflow-y-auto font-mono text-[11px]">
          <div className="flex items-center justify-between px-4 py-2 border-b border-lg-border sticky top-0 bg-lg-bg-elevated">
            <span className="text-[10px] uppercase tracking-widest text-lg-text-secondary">
              Error history ({history.length})
            </span>
            <div className="flex items-center gap-3">
              <button
                onClick={clearHistory}
                className="text-[10px] text-lg-text-secondary hover:text-lg-error transition-colors"
              >
                Clear
              </button>
              <button
                onClick={() => setShowHistory(false)}
                className="text-[10px] text-lg-text-secondary hover:text-lg-text-primary transition-colors"
              >
                ✕
              </button>
            </div>
          </div>

          {history.length === 0 && (
            <div className="px-4 py-3 text-lg-text-secondary text-[10px]">No errors recorded.</div>
          )}

          {history.map((err, i) => (
            <div
              key={i}
              className="flex items-start gap-3 px-4 py-2 border-b border-lg-border/50 hover:bg-lg-bg-secondary transition-colors cursor-pointer"
              onClick={() => { useErrorStore.getState().push(err); setShowHistory(false) }}
            >
              <span className={cn(
                'text-[9px] px-1.5 py-0.5 rounded shrink-0 mt-0.5',
                err.severity === 'fatal' ? 'bg-lg-error/20 text-lg-error' :
                err.severity === 'error' ? 'bg-lg-error/15 text-lg-error' :
                                           'bg-lg-warning/20 text-lg-warning'
              )}>
                {err.code}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-lg-text-primary font-semibold truncate">{err.title}</div>
                <div className="text-lg-text-secondary text-[10px] truncate">{err.description}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: 'var(--lg-font-ui)', fontSize: 9.5, fontWeight: 700,
      letterSpacing: '0.1em', textTransform: 'uppercase', color: '#5a6880', marginBottom: 6,
    }}>
      {children}
    </div>
  )
}

function HeaderBtn({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flexShrink: 0, background: hover ? '#1e2a3d' : 'transparent', border: 'none',
        borderRadius: 5, padding: '3px 8px', cursor: 'pointer',
        fontFamily: 'var(--lg-font-ui)', fontSize: 11, fontWeight: 600,
        color: hover ? '#e8f1ff' : '#7b8499', transition: 'background 0.12s, color 0.12s',
      }}
    >
      {label}
    </button>
  )
}

function ErrorGlyph({ color, severity }: { color: string; severity: LucidGitError['severity'] }) {
  // Triangle warning for warnings, octagon-ish circle-X for errors/fatal.
  if (severity === 'warning') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
        <path d="M8 1.5L14.5 13H1.5L8 1.5Z" stroke={color} strokeWidth="1.3" strokeLinejoin="round" fill={`${color}1f`} />
        <path d="M8 6v3.5" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="8" cy="11.4" r="0.75" fill={color} />
      </svg>
    )
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="8" cy="8" r="6.5" stroke={color} strokeWidth="1.3" fill={`${color}1f`} />
      <path d="M5.7 5.7l4.6 4.6M10.3 5.7l-4.6 4.6" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function FixRow({
  step, busy, copied, onDispatch, onCopy,
}: {
  step: FixStep
  busy: boolean
  copied: string | null
  onDispatch: (a: FixAction) => void
  onCopy: (text: string, key: string) => void
}) {
  const hasAction  = !!step.action
  const hasCommand = !!step.command

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
      <span style={{ flexShrink: 0, color: '#4a566a', marginTop: 1 }}>→</span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.5, color: '#c2ccdf', fontFamily: 'var(--lg-font-ui)' }}>
        {step.label}
        {hasCommand && (
          <code style={{
            display: 'block', marginTop: 3, fontFamily: 'var(--lg-font-mono)', fontSize: 10.5,
            color: '#8a94aa', wordBreak: 'break-all',
          }}>{step.command}</code>
        )}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        {hasCommand && (
          <ActionBtn
            onClick={() => onCopy(step.command!, `cmd-${step.label}`)}
            title={step.command}
            size="sm"
            style={{ height: 22, paddingLeft: 8, paddingRight: 8, fontSize: 10 }}
          >
            {copied === `cmd-${step.label}` ? '✓' : 'Copy'}
          </ActionBtn>
        )}
        {hasAction && (
          <ActionBtn
            onClick={() => onDispatch(step.action!)}
            disabled={busy}
            size="sm"
            style={{ height: 22, paddingLeft: 10, paddingRight: 10, fontSize: 10, fontWeight: 600 }}
          >
            {busy ? '…' : 'Fix'}
          </ActionBtn>
        )}
      </div>
    </div>
  )
}

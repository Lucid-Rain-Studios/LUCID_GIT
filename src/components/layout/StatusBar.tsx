import React, { useState, useRef, useEffect } from 'react'
import { useRepoStore } from '@/stores/repoStore'
import { useOperationStore } from '@/stores/operationStore'
import { useAuthStore } from '@/stores/authStore'
import { RepoPermission } from '@/ipc'
import { compactPath } from '@/lib/pathDisplay'

declare const __APP_VERSION__: string

const ROLE_OPTIONS: { value: RepoPermission | null; label: string; description: string }[] = [
  { value: null,    label: 'Admin',        description: 'Your real role — full access' },
  { value: 'write', label: 'Collaborator', description: 'Write access, no admin settings' },
  { value: 'read',  label: 'Read-only',    description: 'View only, no write actions' },
]

const ROLE_LABELS: Record<string, string> = { admin: 'Admin', write: 'Collaborator', read: 'Read-only' }

export function StatusBar() {
  const { currentBranch, repoPath } = useRepoStore()
  const { isRunning, label, latestStep, startedAt, latestStepAt, feedback } = useOperationStore()
  const { repoPermissions, permissionFetching, fetchRepoPermission, viewAsRole, setViewAsRole } = useAuthStore()
  const [roleMenuOpen, setRoleMenuOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [clock, setClock] = useState(Date.now())
  const roleMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (repoPath) fetchRepoPermission(repoPath)
  }, [repoPath])

  useEffect(() => {
    if (!roleMenuOpen) return
    function onMouseDown(e: MouseEvent) {
      if (roleMenuRef.current && !roleMenuRef.current.contains(e.target as Node)) {
        setRoleMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [roleMenuOpen])

  useEffect(() => {
    if (!isRunning) return
    const timer = setInterval(() => setClock(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [isRunning])

  useEffect(() => setDetailsOpen(false), [feedback])

  const realPermission  = repoPath ? repoPermissions[repoPath] : undefined
  const isRealAdmin     = realPermission === 'admin'
  const isOverriding    = isRealAdmin && viewAsRole !== null
  const effectiveRole   = isRealAdmin && viewAsRole ? viewAsRole : realPermission

  const progress   = latestStep?.progress
  const overallProgress = latestStep?.overallProgress ?? progress
  const current    = latestStep?.current
  const total      = latestStep?.total
  const stepLabel  = latestStep?.label ?? label
  const stepDetail = latestStep?.detail

  // Smoother bar fill when we have per-item counts: 1200 distinct
  // values instead of 100 percentage steps.
  const barFill = overallProgress

  const countText =
    current !== undefined && total !== undefined ? `${current.toLocaleString()}/${total.toLocaleString()}`
    : current !== undefined                      ? current.toLocaleString()
    : null

  const pctText = progress !== undefined ? `${progress}%` : null
  const overallPctText = overallProgress !== undefined && (progress === undefined || Math.abs(overallProgress - progress) >= 1)
    ? `${Math.round(overallProgress)}% overall`
    : null
  const elapsedSeconds = startedAt ? Math.max(0, Math.floor((clock - startedAt) / 1000)) : 0
  const elapsedText = elapsedSeconds >= 60 ? `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s` : `${elapsedSeconds}s`
  const etaSeconds = overallProgress !== undefined && overallProgress >= 5 && overallProgress < 100 && elapsedSeconds >= 2
    ? Math.max(1, Math.round(elapsedSeconds * (100 - overallProgress) / overallProgress))
    : null
  const etaText = etaSeconds === null ? null : etaSeconds >= 60
    ? `~${Math.floor(etaSeconds / 60)}m ${etaSeconds % 60}s left`
    : `~${etaSeconds}s left`
  const waiting = latestStepAt !== null && clock - latestStepAt > 2_500
    && /connect|remote|credential|prepar/i.test(stepLabel)

  // Detail strings that look like file paths get compacted (parent/.../file)
  // so the status bar stays readable even for deeply-nested paths.
  const isPathLikeDetail = stepDetail !== undefined
    && /[\\/]/.test(stepDetail)
    && !/\s/.test(stepDetail)
    && !stepDetail.includes('%')

  const displayDetail = isPathLikeDetail && stepDetail
    ? compactPath(stepDetail)
    : stepDetail

  // Prefer structured count when present; otherwise fall back to the
  // raw detail (e.g. "5.2 MB / 12.4 MB · 1.5 MB/s" from the auto-updater).
  const baseDisplayText = countText
    ? [stepLabel, pctText, countText].filter(Boolean).join('  ·  ')
    : displayDetail
      ? (pctText && !displayDetail.includes('%')) ? `${displayDetail}  ${pctText}` : displayDetail
      : pctText
        ? `${stepLabel}  ${pctText}`
        : stepLabel

  const transferDetail = displayDetail && /(?:[KMGT]i?B|bytes)(?:\/s|\/sec)?/i.test(displayDetail) ? displayDetail : null
  const contextualDetail = transferDetail ?? (isPathLikeDetail ? displayDetail : null)
  const phaseLabel = waiting ? 'Waiting for remote' : stepLabel
  const displayText = [
    phaseLabel,
    pctText,
    countText,
    contextualDetail,
    overallPctText,
    elapsedText,
    etaText,
  ].filter(Boolean).join('  ·  ') || baseDisplayText

  // Tooltip shows the full, un-compacted detail (e.g. the original file path)
  // plus the operation label so the user can hover to see exactly what's
  // being processed.
  const tooltipText = stepDetail
    ? `${stepLabel}\n${stepDetail}`
    : label
      ? label
      : stepLabel

  return (
    <footer style={{
      position: 'relative', display: 'flex', flexDirection: 'column',
      background: 'var(--lg-bg-secondary)',
      borderTop: '1px solid var(--lg-border)',
      flexShrink: 0, overflow: 'visible', zIndex: 10,
    }}>
      {/* Progress strip */}
      <div style={{ height: 2, width: '100%', background: '#141924', overflow: 'hidden' }}>
        {isRunning && (
          barFill !== undefined
            ? <div style={{
                height: '100%',
                background: 'linear-gradient(90deg, #e8622f, #f5a832)',
                width: `${barFill}%`,
                transition: 'width 0.3s ease',
                boxShadow: '0 0 6px rgba(232,98,47,0.6)',
              }} />
            : <div style={{
                height: '100%', width: '28%',
                background: 'linear-gradient(90deg, transparent, #e8622f 40%, #f5a832 60%, transparent)',
                animation: 'sweep 1.5s ease-in-out infinite',
              }} />
        )}
      </div>

      {/* Content row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 26, paddingLeft: 14, paddingRight: 14 }}>
        {/* Left: branch */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {currentBranch ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--lg-font-mono)', fontSize: 10.5, color: '#4a9eff' }}>
              <BranchIcon />
              {currentBranch}
            </span>
          ) : (
            <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10.5, color: '#283047' }}>
              {repoPath ? 'No branch' : 'No repository'}
            </span>
          )}
        </div>

        {/* Right: permission badge + status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {repoPath && (
            permissionFetching[repoPath]
              ? <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 9.5, color: '#283047' }}>checking…</span>
              : isRealAdmin
                ? (
                  <div ref={roleMenuRef} style={{ position: 'relative' }}>
                    <button
                      onClick={() => setRoleMenuOpen(v => !v)}
                      title={isOverriding ? `Previewing as ${ROLE_LABELS[effectiveRole!]}. Click to change.` : 'Admin — click to preview as another role'}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 3,
                        paddingLeft: 6, paddingRight: 5, height: 15, borderRadius: 9,
                        background: isOverriding ? 'rgba(167,139,250,0.1)' : 'rgba(45,189,110,0.1)',
                        border: `1px solid ${isOverriding ? 'rgba(167,139,250,0.33)' : 'rgba(45,189,110,0.33)'}`,
                        color: isOverriding ? '#a78bfa' : '#2dbd6e',
                        fontFamily: 'var(--lg-font-mono)', fontSize: 9, fontWeight: 700,
                        cursor: 'pointer', userSelect: 'none', flexShrink: 0, letterSpacing: '0.04em',
                        outline: 'none',
                      }}
                    >
                      {isOverriding ? ROLE_LABELS[effectiveRole!] : 'Admin'}
                      <svg width="6" height="4" viewBox="0 0 6 4" fill="none" style={{ opacity: 0.7 }}>
                        <path d="M0.5 0.5L3 3L5.5 0.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>

                    {roleMenuOpen && (
                      <div style={{
                        position: 'absolute', bottom: 'calc(100% + 6px)', right: 0,
                        background: '#1a2035', border: '1px solid #252d42', borderRadius: 6,
                        padding: 4, zIndex: 100, minWidth: 180,
                        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
                      }}>
                        <div style={{
                          paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 5,
                          fontSize: 9, fontFamily: 'var(--lg-font-mono)',
                          color: '#8b94b0', letterSpacing: '0.06em',
                        }}>
                          PREVIEW AS ROLE
                        </div>
                        {ROLE_OPTIONS.map(opt => (
                          <RoleMenuOption
                            key={String(opt.value)}
                            label={opt.label}
                            description={opt.description}
                            active={viewAsRole === opt.value}
                            onClick={() => { setViewAsRole(opt.value); setRoleMenuOpen(false) }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )
                : realPermission === 'write'
                  ? <PermBadge label="Collaborator" color="#7b8499" bg="rgba(123,132,153,0.08)" title="You have write access (collaborator)" />
                  : null
          )}
          <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 9.5, color: '#42506a', letterSpacing: '0.03em' }}>
            v{__APP_VERSION__}
          </span>
          {isRunning ? (
            <span
              title={tooltipText}
              style={{
                fontFamily: 'var(--lg-font-mono)', fontSize: 10.5, color: '#e8622f',
                animation: 'pulse 1.6s ease-in-out infinite',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                maxWidth: 640,
                cursor: 'help',
              }}
            >
              {displayText}
            </span>
          ) : feedback ? (
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => feedback.kind === 'error' && setDetailsOpen(v => !v)}
                title={feedback.details}
                style={{
                  border: 'none', background: 'transparent', padding: 0,
                  fontFamily: 'var(--lg-font-mono)', fontSize: 10.5,
                  color: feedback.kind === 'error' ? '#ef6b73' : '#5fbf7f',
                  cursor: feedback.kind === 'error' ? 'pointer' : 'default',
                }}
              >
                {feedback.kind === 'error' ? '✕' : '✓'} {feedback.text}{feedback.kind === 'error' ? ' · Details' : ''}
              </button>
              {detailsOpen && feedback.details && (
                <div style={{
                  position: 'absolute', bottom: 'calc(100% + 7px)', right: 0, width: 420, maxHeight: 180,
                  overflow: 'auto', padding: '10px 12px', borderRadius: 6,
                  background: '#171b27', border: '1px solid #44303a', color: '#d8a2a7',
                  boxShadow: '0 8px 28px rgba(0,0,0,0.5)', whiteSpace: 'pre-wrap',
                  fontFamily: 'var(--lg-font-mono)', fontSize: 10, lineHeight: 1.45, zIndex: 120,
                }}>
                  {feedback.details}
                </div>
              )}
            </div>
          ) : (
            <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#1e2a3a', letterSpacing: '0.03em' }}>
              Ready
            </span>
          )}
        </div>
      </div>
    </footer>
  )
}

function RoleMenuOption({ label, description, active, onClick }: {
  label: string; description: string; active: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', flexDirection: 'column', width: '100%', textAlign: 'left',
        padding: '5px 8px', border: 'none', borderRadius: 4, cursor: 'pointer', gap: 1,
        background: active ? 'rgba(167,139,250,0.12)' : 'transparent',
      }}
    >
      <span style={{
        color: active ? '#a78bfa' : '#c8d0e8',
        fontSize: 10.5, fontFamily: 'var(--lg-font-ui)',
        fontWeight: active ? 600 : 400,
      }}>
        {active ? '✓ ' : '  '}{label}
      </span>
      <span style={{ color: '#8b94b0', fontSize: 9, fontFamily: 'var(--lg-font-mono)' }}>
        {description}
      </span>
    </button>
  )
}

function PermBadge({ label, color, bg, title }: { label: string; color: string; bg: string; title: string }) {
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center',
        paddingLeft: 6, paddingRight: 6, height: 15, borderRadius: 9,
        background: bg, border: `1px solid ${color}33`,
        color, fontFamily: 'var(--lg-font-mono)', fontSize: 9, fontWeight: 700,
        cursor: 'default', userSelect: 'none', flexShrink: 0, letterSpacing: '0.04em',
      }}
    >{label}</span>
  )
}

function BranchIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="5" cy="4"  r="1.75" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="5" cy="12" r="1.75" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="11" cy="4" r="1.75" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5 5.75V10.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M5 5.75C5 7.5 11 7.5 11 5.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

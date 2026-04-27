import React, { useState, useRef, useEffect } from 'react'
import { useRepoStore } from '@/stores/repoStore'
import { useOperationStore } from '@/stores/operationStore'
import { useAuthStore } from '@/stores/authStore'
import { RepoPermission } from '@/ipc'

const ROLE_OPTIONS: { value: RepoPermission | null; label: string; description: string }[] = [
  { value: null,    label: 'Admin',        description: 'Your real role — full access' },
  { value: 'write', label: 'Collaborator', description: 'Write access, no admin settings' },
  { value: 'read',  label: 'Read-only',    description: 'View only, no write actions' },
]

const ROLE_LABELS: Record<string, string> = { admin: 'Admin', write: 'Collaborator', read: 'Read-only' }

export function StatusBar() {
  const { currentBranch, repoPath } = useRepoStore()
  const { isRunning, label, latestStep } = useOperationStore()
  const { repoPermissions, permissionFetching, fetchRepoPermission, viewAsRole, setViewAsRole } = useAuthStore()
  const [roleMenuOpen, setRoleMenuOpen] = useState(false)
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

  const realPermission  = repoPath ? repoPermissions[repoPath] : undefined
  const isRealAdmin     = realPermission === 'admin'
  const isOverriding    = isRealAdmin && viewAsRole !== null
  const effectiveRole   = isRealAdmin && viewAsRole ? viewAsRole : realPermission

  const progress   = latestStep?.progress
  const stepLabel  = latestStep?.label ?? label
  const stepDetail = latestStep?.detail

  const displayText = stepDetail
    ? progress !== undefined && !stepDetail.includes('%')
      ? `${stepDetail}  ${progress}%`
      : stepDetail
    : progress !== undefined
      ? `${stepLabel}  ${progress}%`
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
          progress !== undefined
            ? <div style={{
                height: '100%',
                background: 'linear-gradient(90deg, #e8622f, #f5a832)',
                width: `${progress}%`,
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
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: '#4a9eff' }}>
              <BranchIcon />
              {currentBranch}
            </span>
          ) : (
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: '#283047' }}>
              {repoPath ? 'No branch' : 'No repository'}
            </span>
          )}
        </div>

        {/* Right: permission badge + status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {repoPath && (
            permissionFetching[repoPath]
              ? <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, color: '#283047' }}>checking…</span>
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
                        fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700,
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
                          fontSize: 9, fontFamily: "'JetBrains Mono', monospace",
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
          {isRunning ? (
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: '#e8622f',
              animation: 'pulse 1.6s ease-in-out infinite',
              maxWidth: 480, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {displayText}
            </span>
          ) : (
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#1e2a3a', letterSpacing: '0.03em' }}>
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
        fontSize: 10.5, fontFamily: "'IBM Plex Sans', system-ui",
        fontWeight: active ? 600 : 400,
      }}>
        {active ? '✓ ' : '  '}{label}
      </span>
      <span style={{ color: '#8b94b0', fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}>
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
        color, fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700,
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

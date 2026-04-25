import React, { useEffect } from 'react'
import { useRepoStore } from '@/stores/repoStore'
import { useOperationStore } from '@/stores/operationStore'
import { useAuthStore } from '@/stores/authStore'

export function StatusBar() {
  const { currentBranch, repoPath } = useRepoStore()
  const { isRunning, label, latestStep } = useOperationStore()
  const { repoPermissions, permissionFetching, fetchRepoPermission } = useAuthStore()

  useEffect(() => {
    if (repoPath) fetchRepoPermission(repoPath)
  }, [repoPath])

  const permission = repoPath ? repoPermissions[repoPath] : undefined
  const fetching   = repoPath ? permissionFetching[repoPath] : false

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
      background: '#0f1219',
      borderTop: '1px solid #151c28',
      flexShrink: 0, overflow: 'hidden', zIndex: 10,
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
            fetching
              ? <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, color: '#283047' }}>checking…</span>
              : permission === 'admin'
                ? <PermBadge label="Admin" color="#2dbd6e" bg="rgba(45,189,110,0.1)" title="You have admin access to this repository" />
                : permission === 'write'
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

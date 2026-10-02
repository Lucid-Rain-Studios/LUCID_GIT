import React, { useState } from 'react'
import { ForecastConflict } from '@/ipc'
import { FilePathText } from '@/components/ui/FilePathText'
import { ActionBtn } from '@/components/ui/ActionBtn'

interface Props {
  repoPath: string
  conflicts: ForecastConflict[]
  error?: string | null
  enabled: boolean
  lastPolledAt: number | null
  onStart: () => void
  onStop: () => void
}

const SEVERITY_COLOR = {
  high:   { bg: 'rgba(232,69,69,0.15)',   text: '#e84545', border: 'rgba(232,69,69,0.3)' },
  medium: { bg: 'rgba(245,168,50,0.15)',  text: '#f5a832', border: 'rgba(245,168,50,0.3)' },
  low:    { bg: 'rgba(77,157,255,0.15)',  text: '#4d9dff', border: 'rgba(77,157,255,0.3)' },
}

function timeAgo(ts: number | null): string {
  if (!ts) return 'never'
  const d = (Date.now() - ts) / 1000
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  return `${Math.floor(d / 3600)}h ago`
}

export function ForecastPanel({ conflicts, enabled, lastPolledAt, error, onStart, onStop }: Props) {
  const [expandedFile, setExpandedFile] = useState<string | null>(null)

  const grouped = new Map<string, ForecastConflict[]>()
  for (const c of conflicts) {
    const group = grouped.get(c.filePath) ?? []
    group.push(c)
    grouped.set(c.filePath, group)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #252d42', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#e8622f', fontWeight: 700, letterSpacing: '0.05em', flex: 1 }}>
            CONFLICT FORECAST
          </span>
          <ActionBtn
            onClick={enabled ? onStop : onStart}
            color={enabled ? '#e84545' : undefined}
            size="sm"
            style={{ height: 24, paddingLeft: 10, paddingRight: 10, fontSize: 11 }}
          >
            {enabled ? 'Stop' : 'Start'}
          </ActionBtn>
        </div>
        {enabled && (
          <div style={{ marginTop: 4, fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#4e5870' }}>
            Polling every 5 min · last checked {timeAgo(lastPolledAt)} · checks at most the first 10 remote branches
          </div>
        )}
      </div>

      {error && <div role="alert" className="p-3 text-xs text-lg-warning">Forecast data is stale: {error} <button onClick={onStart}>Retry</button></div>}
      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!enabled && !error && lastPolledAt !== null && conflicts.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 14, color: '#4e5870', marginBottom: 8 }}>
              Forecast is off
            </div>
            <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#2f3a54', marginBottom: 16 }}>
              Enable to detect files where remote branches have diverged from your working changes.
            </div>
            <ActionBtn
              onClick={onStart}
              style={{ height: 32, paddingLeft: 16, paddingRight: 16, fontSize: 13, fontWeight: 600 }}
            >Enable Forecasting</ActionBtn>
          </div>
        )}

        {enabled && conflicts.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>✓</div>
            <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 14, color: '#2ec573' }}>
              No forecast conflicts
            </div>
            <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#4e5870', marginTop: 4 }}>
              No overlaps found among the checked branches. Coverage is limited to the first 10 remote branches.
            </div>
          </div>
        )}

        {[...grouped.entries()].map(([filePath, fileConflicts]) => {
          const maxSeverity = fileConflicts.find(c => c.severity === 'high')?.severity
            ?? fileConflicts.find(c => c.severity === 'medium')?.severity ?? 'low'
          const colors = SEVERITY_COLOR[maxSeverity]
          const expanded = expandedFile === filePath

          return (
            <div key={filePath} style={{ borderBottom: '1px solid #1a1e2e' }}>
              <div
                onClick={() => setExpandedFile(expanded ? null : filePath)}
                style={{ padding: '8px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}
                onMouseEnter={e => { e.currentTarget.style.background = '#131726' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 8, height: 8, borderRadius: '50%', background: colors.text, flexShrink: 0,
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <FilePathText path={filePath} style={{ display: 'block', fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#dde1f0' }} />
                  <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#4e5870' }}>
                    {fileConflicts.length} remote branch{fileConflicts.length !== 1 ? 'es' : ''} ahead
                  </div>
                </div>
                <span style={{
                  fontSize: 9, padding: '1px 5px', borderRadius: 8,
                  background: colors.bg, color: colors.text, border: `1px solid ${colors.border}`,
                  fontFamily: 'var(--lg-font-ui)', flexShrink: 0,
                }}>{maxSeverity}</span>
                <span style={{ fontSize: 9, color: '#4e5870', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
              </div>

              {expanded && (
                <div style={{ padding: '0 16px 10px 32px' }}>
                  <FilePathText path={filePath} style={{ display: 'block', fontFamily: 'var(--lg-font-mono)', fontSize: 9, color: '#2f3a54', marginBottom: 8 }} />
                  {fileConflicts.map((c, i) => (
                    <div key={i} style={{ padding: '6px 0', borderTop: '1px solid #1e2436' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                        <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#4d9dff' }}>{c.remoteBranch}</span>
                        <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#4e5870' }}>{c.remoteLastCommit}</span>
                      </div>
                      <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#8b94b0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.remoteLastMessage}
                      </div>
                      <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#4e5870' }}>
                        by {c.remoteLastAuthor}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

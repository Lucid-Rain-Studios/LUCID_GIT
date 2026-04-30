import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ipc, SyncStatus, LFSStatus,
  CommitEntry, BranchActivity, SizeBreakdown, PullRequest, ConflictPreviewFile,
} from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { useOperationStore } from '@/stores/operationStore'

interface OverviewPanelProps {
  repoPath: string
  onNavigate: (tab: string) => void
  onRefresh:  () => void
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1_048_576)    return `${(b / 1024).toFixed(1)} KB`
  if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(1)} MB`
  return `${(b / 1_073_741_824).toFixed(2)} GB`
}

function timeAgoMs(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 60)     return 'just now'
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(ts).toLocaleDateString()
}

function timeAgoStr(iso: string): string {
  return timeAgoMs(new Date(iso).getTime())
}

function authorColor(name: string): string {
  const palette = ['#4a9eff', '#a27ef0', '#2dbd6e', '#f5a832', '#e8622f', '#1abc9c', '#e91e63']
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function parseGitHubSlug(url: string): string | null {
  const m = url.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)
  return m ? m[1] : null
}

// ── Card ──────────────────────────────────────────────────────────────────────

function Card({
  title, icon, children, actionLabel, onAction, accentColor, style: xStyle,
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
  actionLabel?: string
  onAction?: () => void
  accentColor?: string
  style?: React.CSSProperties
}) {
  return (
    <div style={{
      background: '#131720',
      border: '1px solid #1a2030',
      borderRadius: 10,
      boxShadow: '0 2px 8px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.025)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      ...xStyle,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, height: 34,
        paddingLeft: 13, paddingRight: 9, flexShrink: 0,
        borderBottom: '1px solid #18202e',
        background: 'rgba(0,0,0,0.15)',
      }}>
        <span style={{ color: accentColor ?? '#344057', display: 'flex', flexShrink: 0 }}>{icon}</span>
        <span style={{
          fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10.5, fontWeight: 700,
          color: '#4a566a', flex: 1, letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>{title}</span>
        {actionLabel && onAction && (
          <button
            onClick={onAction}
            style={{
              fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#4a9eff',
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '2px 8px', borderRadius: 4,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = '#e8622f'; e.currentTarget.style.background = 'rgba(232,98,47,0.08)' }}
            onMouseLeave={e => { e.currentTarget.style.color = '#4a9eff'; e.currentTarget.style.background = 'none' }}
          >{actionLabel} →</button>
        )}
      </div>
      {children}
    </div>
  )
}

// ── Inline action button ───────────────────────────────────────────────────────

function Btn({
  label, onClick, loading, color, disabled,
}: {
  label: string; onClick: () => void; loading?: boolean; color?: string; disabled?: boolean
}) {
  const [hover, setHover] = useState(false)
  const c = color ?? '#7b8499'
  const off = loading || disabled
  return (
    <button
      onClick={off ? undefined : onClick}
      onMouseEnter={() => !off && setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 25, paddingLeft: 13, paddingRight: 13, borderRadius: 5,
        background: hover ? `${c}14` : 'rgba(255,255,255,0.02)',
        border: `1px solid ${hover ? c + '55' : '#1a2030'}`,
        color: off ? '#344057' : hover ? c : '#5a6880',
        fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11.5, fontWeight: 500,
        cursor: off ? 'default' : 'pointer', opacity: off ? 0.5 : 1,
        boxShadow: hover && !off ? `0 0 12px ${c}18` : 'none',
      }}
    >{loading ? '…' : label}</button>
  )
}

// ── Status chip (health strip) ────────────────────────────────────────────────

function StatusChip({
  dot, label, onClick,
}: { dot: string; label: string; onClick?: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        height: 26, paddingLeft: 9, paddingRight: 11,
        background: hover && onClick ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)',
        border: `1px solid ${hover && onClick ? '#283047' : '#18202e'}`,
        borderRadius: 6,
        cursor: onClick ? 'pointer' : 'default',
        flexShrink: 0,
        boxShadow: hover && onClick ? `0 0 10px ${dot}18` : 'none',
      }}
    >
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: dot, boxShadow: `0 0 5px ${dot}99`, flexShrink: 0 }} />
      <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11.5, color: '#5a6880', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </div>
  )
}

// ── Metric within a card ──────────────────────────────────────────────────────

function Metric({ label, value, color, sub }: { label: string; value: string | number; color: string; sub?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, fontWeight: 700, color: '#344057', letterSpacing: '0.1em', textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 21, fontWeight: 700, color, lineHeight: 1, textShadow: `0 0 20px ${color}40` }}>{value}</span>
      {sub && <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#344057', marginTop: 1 }}>{sub}</span>}
    </div>
  )
}

// ── LFS health card ───────────────────────────────────────────────────────────

function LfsCard({ lfs, onNavigate }: { lfs: LFSStatus | null; onNavigate: (t: string) => void }) {
  const warnCount = lfs?.untracked.length ?? 0
  return (
    <Card
      title="LFS Health"
      icon={<LFSCardIcon />}
      accentColor="#4d9dff"
      actionLabel="Manage"
      onAction={() => onNavigate('lfs')}
    >
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {lfs ? (
          <>
            <div style={{ display: 'flex', gap: 20 }}>
              <Metric label="Objects" value={lfs.objects}                color="#4d9dff"  sub="tracked files" />
              <Metric label="Size"    value={fmtBytes(lfs.totalBytes)}   color="#dde1f0"  sub="LFS stored"    />
            </div>

            <div>
              <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, fontWeight: 600, color: '#344057', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 6 }}>
                {lfs.tracked.length} tracked pattern{lfs.tracked.length !== 1 ? 's' : ''}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {lfs.tracked.slice(0, 8).map((p, i) => (
                  <span key={i} style={{
                    fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
                    background: 'rgba(255,255,255,0.04)', color: '#5a6880', borderRadius: 4, padding: '2px 7px',
                  }}>{p}</span>
                ))}
                {lfs.tracked.length > 8 && (
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#344057', padding: '2px 0' }}>+{lfs.tracked.length - 8}</span>
                )}
                {lfs.tracked.length === 0 && (
                  <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#344057' }}>No patterns — LFS not configured</span>
                )}
              </div>
            </div>

            {warnCount > 0 && (
              <div style={{
                background: 'rgba(245,168,50,0.08)', border: '1px solid rgba(245,168,50,0.3)',
                borderRadius: 7, padding: '9px 12px',
              }}>
                <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#f5a832', fontWeight: 600, marginBottom: 5 }}>
                  ⚠ {warnCount} large file{warnCount !== 1 ? 's' : ''} not in LFS
                </div>
                {lfs!.untracked.slice(0, 4).map((f, i) => (
                  <div key={i} style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#5a6880', padding: '1px 0' }}>{f}</div>
                ))}
                {warnCount > 4 && (
                  <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#344057', marginTop: 2 }}>+{warnCount - 4} more</div>
                )}
              </div>
            )}
          </>
        ) : (
          <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#344057' }}>LFS data unavailable</span>
        )}
      </div>
    </Card>
  )
}

// ── Repository size card ──────────────────────────────────────────────────────

function SizeCard({ size, sizeLoading, onNavigate }: { size: SizeBreakdown | null; sizeLoading: boolean; onNavigate: (t: string) => void }) {
  if (!size) return (
    <Card title="Repository Size" icon={<SizeCardIcon />} accentColor="#a27ef0">
      <div style={{ padding: 14 }}>
        <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#344057' }}>
          {sizeLoading ? 'Measuring…' : 'Size data unavailable'}
        </span>
      </div>
    </Card>
  )

  const sizeColor = size.totalBytes > 5 * 1_073_741_824 ? '#e84545'
    : size.totalBytes > 2 * 1_073_741_824 ? '#f5a832'
    : '#2dbd6e'

  const bars: { label: string; bytes: number; color: string }[] = [
    { label: 'Git Objects', bytes: size.objectsBytes,  color: '#4a9eff' },
    { label: 'Pack Files',  bytes: size.packsBytes,    color: '#a27ef0' },
    { label: 'LFS Cache',   bytes: size.lfsCacheBytes, color: '#2dbd6e' },
    { label: 'Logs',        bytes: size.logsBytes,     color: '#344057' },
  ].filter(b => b.bytes > 0)

  const maxBytes = Math.max(...bars.map(b => b.bytes), 1)

  return (
    <Card
      title="Repository Size"
      icon={<SizeCardIcon />}
      accentColor="#a27ef0"
      actionLabel="Cleanup"
      onAction={() => onNavigate('cleanup')}
    >
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Metric label="Total on disk" value={fmtBytes(size.totalBytes)} color={sizeColor} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {bars.map(b => (
            <div key={b.label}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#5a6880' }}>{b.label}</span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#344057' }}>{fmtBytes(b.bytes)}</span>
              </div>
              <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2 }}>
                <div style={{
                  height: 4, borderRadius: 2, background: b.color,
                  width: `${(b.bytes / maxBytes) * 100}%`,
                  opacity: 0.7, transition: 'width 0.4s ease',
                }} />
              </div>
            </div>
          ))}
        </div>

        {size.totalBytes > 2 * 1_073_741_824 && (
          <div style={{
            background: 'rgba(245,168,50,0.08)', border: '1px solid rgba(245,168,50,0.25)',
            borderRadius: 6, padding: '8px 10px',
            fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#f5a832',
          }}>
            Repository is getting large. Run cleanup to reclaim space.
          </div>
        )}
      </div>
    </Card>
  )
}

// ── Branch activity card ──────────────────────────────────────────────────────

const COMMITS_HEIGHT = 340

function ActivityCard({ activity, onNavigate }: { activity: BranchActivity[]; onNavigate: (t: string) => void }) {
  return (
    <Card
      title="Branch Activity"
      icon={<ActivityCardIcon />}
      accentColor="#4d9dff"
      actionLabel="History"
      onAction={() => onNavigate('history')}
      style={{ height: COMMITS_HEIGHT + 34 }}
    >
      {activity.length === 0 ? (
        <div style={{ padding: '16px 14px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#344057' }}>
          No recent branch activity
        </div>
      ) : (
        <div style={{ overflowY: 'auto', height: COMMITS_HEIGHT }}>
          {activity.slice(0, 12).map((item, i) => {
            const branch = item.ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/[^/]+\//, '')
            const col = authorColor(item.author)
            const ini = initials(item.author)
            return (
              <div
                key={i}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9,
                  padding: '8px 14px', borderBottom: '1px solid #18202e',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{
                  width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                  background: `linear-gradient(135deg, ${col}88, ${col}44)`,
                  border: `1px solid ${col}55`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 7, fontWeight: 700, color: col,
                }}>{ini}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4a9eff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{branch}</span>
                    <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#344057', flexShrink: 0 }}>{timeAgoStr(item.date)}</span>
                  </div>
                  <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#5a6880', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.message}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ── Recent commits card ───────────────────────────────────────────────────────

function CommitsCard({ commits, onNavigate }: { commits: CommitEntry[]; onNavigate: (t: string) => void }) {
  return (
    <Card
      title="Recent Commits"
      icon={<CommitCardIcon />}
      accentColor="#a27ef0"
      actionLabel="Full History"
      onAction={() => onNavigate('history')}
      style={{ height: COMMITS_HEIGHT + 34 }}
    >
      {commits.length === 0 ? (
        <div style={{ padding: '16px 14px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#344057' }}>No commits yet</div>
      ) : (
        <div style={{ overflowY: 'auto', height: COMMITS_HEIGHT }}>
          {commits.map(c => {
            const col = authorColor(c.author)
            const ini = initials(c.author)
            const isMerge = c.parentHashes.length > 1
            return (
              <div
                key={c.hash}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  height: 46, paddingLeft: 14, paddingRight: 14,
                  borderBottom: '1px solid #18202e', transition: 'background 0.1s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{
                  width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                  background: `linear-gradient(135deg, ${col}88, ${col}44)`,
                  border: `1px solid ${col}55`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 8, fontWeight: 700, color: col,
                }}>{ini}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span style={{
                      fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, fontWeight: 500, color: '#e2e6f4',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                    }}>{c.message}</span>
                    {isMerge && (
                      <span style={{
                        background: 'rgba(162,126,240,0.15)', color: '#a27ef0',
                        border: '1px solid rgba(162,126,240,0.3)',
                        borderRadius: 4, padding: '1px 5px',
                        fontFamily: "'JetBrains Mono', monospace", fontSize: 9, flexShrink: 0,
                      }}>MERGE</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#5a6880' }}>{c.author}</span>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#344057' }}>{timeAgoMs(c.timestamp)}</span>
                  </div>
                </div>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#344057', flexShrink: 0 }}>
                  {c.hash.slice(0, 7)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ── PR Resolve Dialog ─────────────────────────────────────────────────────────

type ConflictChoice = 'branch' | 'base'

function ResolveDialog({
  pr, ghSlug, repoPath, onClose, onDone,
}: {
  pr: PullRequest
  ghSlug: string
  repoPath: string
  onClose: () => void
  onDone: () => void
}) {
  const opRun         = useOperationStore(s => s.run)
  const bumpHistoryTick = useRepoStore(s => s.bumpHistoryTick)
  const bumpPrTick      = useRepoStore(s => s.bumpPrTick)
  const [choice, setChoice] = useState<'accept' | 'decline'>('accept')
  const [conflicts, setConflicts] = useState<ConflictPreviewFile[]>([])
  const [conflictLoading, setConflictLoading] = useState(false)
  const [fileChoices, setFileChoices] = useState<Record<string, ConflictChoice>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (choice !== 'accept') return
    setConflictLoading(true)
    ipc.mergePreview(repoPath, pr.headBranch)
      .then(files => {
        setConflicts(files)
        const defaults: Record<string, ConflictChoice> = {}
        files.forEach(f => { defaults[f.path] = 'branch' })
        setFileChoices(defaults)
      })
      .catch(() => setConflicts([]))
      .finally(() => setConflictLoading(false))
  }, [choice, repoPath, pr.headBranch])

  const handleConfirm = async () => {
    const [owner, repo] = ghSlug.split('/')
    setBusy(true)
    try {
      if (choice === 'accept') {
        await opRun(`Merging PR #${pr.number}…`, () => ipc.githubMergePR({ owner, repo, prNumber: pr.number, repoPath }))
        bumpHistoryTick()
        bumpPrTick()
      } else {
        await opRun(`Closing PR #${pr.number}…`, () => ipc.githubClosePR({ owner, repo, prNumber: pr.number }))
        bumpPrTick()
      }
      onDone()
      onClose()
    } catch { /* surfaced via operationStore */ }
    finally { setBusy(false) }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 600,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)',
    }}>
      <div style={{
        background: '#131720', border: '1px solid #1a2030',
        borderRadius: 12,
        boxShadow: '0 24px 64px rgba(0,0,0,0.7), 0 4px 16px rgba(0,0,0,0.5)',
        width: 520, maxHeight: '80vh',
        display: 'flex', flexDirection: 'column',
        animation: 'slide-down 0.16s ease both',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '16px 18px 14px', borderBottom: '1px solid #18202e', flexShrink: 0,
        }}>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700,
            color: '#a27ef0', background: 'rgba(162,126,240,0.12)',
            border: '1px solid rgba(162,126,240,0.25)',
            borderRadius: 4, padding: '2px 7px', flexShrink: 0,
          }}>#{pr.number}</span>
          <span style={{
            fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13, fontWeight: 600,
            color: '#c8d0e8', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{pr.title}</span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#344057', cursor: 'pointer', fontSize: 16, padding: '0 4px', flexShrink: 0 }}
            onMouseEnter={e => e.currentTarget.style.color = '#e84545'}
            onMouseLeave={e => e.currentTarget.style.color = '#344057'}
          >✕</button>
        </div>

        {/* Branch info */}
        <div style={{ padding: '10px 18px', borderBottom: '1px solid #18202e', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: '#4a9eff' }}>{pr.headBranch}</span>
          <span style={{ color: '#344057', fontSize: 11 }}>→</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: '#5a6880' }}>{pr.baseBranch}</span>
          <span style={{ color: '#283047', marginLeft: 4 }}>·</span>
          <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#344057' }}>by {pr.author}</span>
        </div>

        {/* Accept / Decline choice */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #18202e', flexShrink: 0 }}>
          <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10.5, fontWeight: 700, color: '#344057', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }}>
            Action
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['accept', 'decline'] as const).map(opt => (
              <button
                key={opt}
                onClick={() => setChoice(opt)}
                style={{
                  flex: 1, height: 34, borderRadius: 7, cursor: 'pointer',
                  fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5, fontWeight: 600,
                  border: choice === opt
                    ? `1px solid ${opt === 'accept' ? 'rgba(45,189,110,0.5)' : 'rgba(232,69,69,0.5)'}`
                    : '1px solid #1a2030',
                  background: choice === opt
                    ? (opt === 'accept' ? 'rgba(45,189,110,0.12)' : 'rgba(232,69,69,0.12)')
                    : 'rgba(255,255,255,0.02)',
                  color: choice === opt
                    ? (opt === 'accept' ? '#2dbd6e' : '#e84545')
                    : '#5a6880',
                }}
              >
                {opt === 'accept' ? '✓ Accept (Merge)' : '✕ Decline (Close)'}
              </button>
            ))}
          </div>
        </div>

        {/* Conflict preview — only when accepting */}
        {choice === 'accept' && (
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {conflictLoading ? (
              <div style={{ padding: '16px 18px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#344057' }}>
                Checking for conflicts…
              </div>
            ) : conflicts.length === 0 ? (
              <div style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: '#2dbd6e', fontSize: 14 }}>✓</span>
                <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#344057' }}>No merge conflicts detected</span>
              </div>
            ) : (
              <>
                <div style={{ padding: '10px 18px 4px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10.5, fontWeight: 700, color: '#f5a832', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  {conflicts.length} conflict{conflicts.length !== 1 ? 's' : ''} — choose resolution per file
                </div>
                {conflicts.map(f => (
                  <div
                    key={f.path}
                    style={{
                      padding: '10px 18px', borderBottom: '1px solid #18202e',
                    }}
                  >
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#c8d0e8', marginBottom: 8 }}>{f.path}</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {(['branch', 'base'] as const).map(side => {
                        const isSelected = (fileChoices[f.path] ?? 'branch') === side
                        const contributor = side === 'branch' ? f.theirs : f.ours
                        const label = side === 'branch' ? `Accept from ${pr.headBranch}` : `Accept from ${pr.baseBranch}`
                        const col = side === 'branch' ? '#4a9eff' : '#a27ef0'
                        return (
                          <button
                            key={side}
                            onClick={() => setFileChoices(prev => ({ ...prev, [f.path]: side }))}
                            style={{
                              flex: 1, borderRadius: 6, padding: '7px 10px', cursor: 'pointer', textAlign: 'left',
                              border: isSelected ? `1px solid ${col}55` : '1px solid #1a2030',
                              background: isSelected ? `${col}10` : 'rgba(255,255,255,0.02)',
                            }}
                          >
                            <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, fontWeight: 600, color: isSelected ? col : '#5a6880', marginBottom: 2 }}>
                              {label}
                            </div>
                            <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#344057' }}>
                              {contributor.lastContributor.name} · {new Date(contributor.lastEditedAt).toLocaleDateString()}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {choice === 'decline' && (
          <div style={{ padding: '16px 18px', flex: 1 }}>
            <div style={{
              background: 'rgba(232,69,69,0.07)', border: '1px solid rgba(232,69,69,0.2)',
              borderRadius: 8, padding: '12px 14px',
              fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#e84545', lineHeight: 1.5,
            }}>
              This will close PR #{pr.number} without merging. The branch will remain intact.
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          padding: '14px 18px', borderTop: '1px solid #18202e', flexShrink: 0,
        }}>
          <button
            onClick={onClose}
            disabled={busy}
            style={{
              height: 32, paddingLeft: 16, paddingRight: 16, borderRadius: 6,
              background: 'transparent', border: '1px solid #1a2030',
              color: '#5a6880', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5,
              cursor: 'pointer',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >Cancel</button>
          <button
            onClick={handleConfirm}
            disabled={busy}
            style={{
              height: 32, paddingLeft: 16, paddingRight: 16, borderRadius: 6,
              background: choice === 'accept' ? 'rgba(45,189,110,0.15)' : 'rgba(232,69,69,0.15)',
              border: `1px solid ${choice === 'accept' ? 'rgba(45,189,110,0.4)' : 'rgba(232,69,69,0.4)'}`,
              color: choice === 'accept' ? '#2dbd6e' : '#e84545',
              fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5, fontWeight: 600,
              cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
            onMouseEnter={e => { if (!busy) e.currentTarget.style.opacity = '0.8' }}
            onMouseLeave={e => { if (!busy) e.currentTarget.style.opacity = '1' }}
          >{busy ? '…' : choice === 'accept' ? 'Merge PR' : 'Close PR'}</button>
        </div>
      </div>
    </div>
  )
}

// ── Admin PR management card ──────────────────────────────────────────────────

function AdminPRsCard({ prs, ghSlug, repoPath, loading, error, onRefresh }: {
  prs: PullRequest[]
  ghSlug: string | null
  repoPath: string
  loading: boolean
  error: string | null
  onRefresh: () => void
}) {
  const [resolving, setResolving] = useState<PullRequest | null>(null)

  return (
    <>
      {resolving && ghSlug && (
        <ResolveDialog
          pr={resolving}
          ghSlug={ghSlug}
          repoPath={repoPath}
          onClose={() => setResolving(null)}
          onDone={onRefresh}
        />
      )}
      <Card
        title="Pull Request Management"
        icon={<PRCardIcon />}
        accentColor="#a27ef0"
        actionLabel={loading ? '…' : 'Refresh'}
        onAction={onRefresh}
      >
        <div style={{ overflowY: 'auto', maxHeight: 360 }}>
          {!ghSlug ? (
            <div style={{ padding: '14px 14px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#344057' }}>
              No GitHub remote configured
            </div>
          ) : error ? (
            <div style={{ padding: '14px 14px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#e84545' }}>
              {error}
            </div>
          ) : loading && prs.length === 0 ? (
            <div style={{ padding: '14px 14px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#344057' }}>
              Loading pull requests…
            </div>
          ) : prs.length === 0 ? (
            <div style={{ padding: '14px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: '#2dbd6e', fontSize: 14 }}>✓</span>
              <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#344057' }}>No open pull requests</span>
            </div>
          ) : (
            prs.map(pr => (
              <div
                key={pr.number}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 14px', borderBottom: '1px solid #18202e',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 700,
                  color: '#a27ef0', background: 'rgba(162,126,240,0.12)',
                  border: '1px solid rgba(162,126,240,0.25)',
                  borderRadius: 4, padding: '2px 6px', flexShrink: 0,
                }}>#{pr.number}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, fontWeight: 500,
                    color: '#c8d0e8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{pr.title}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, color: '#4a9eff' }}>{pr.headBranch}</span>
                    <span style={{ fontSize: 9.5, color: '#283047' }}>→</span>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, color: '#344057' }}>{pr.baseBranch}</span>
                    <span style={{ color: '#283047', fontSize: 9.5 }}>·</span>
                    <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#344057' }}>{pr.author}</span>
                    <span style={{ color: '#283047', fontSize: 9.5 }}>·</span>
                    <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#344057' }}>{timeAgoStr(pr.updatedAt)}</span>
                    {pr.draft && (
                      <span style={{
                        fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, fontWeight: 600,
                        background: 'rgba(90,104,128,0.15)', color: '#5a6880',
                        border: '1px solid rgba(90,104,128,0.25)', borderRadius: 3,
                        padding: '0 4px', letterSpacing: '0.05em',
                      }}>DRAFT</span>
                    )}
                  </div>
                </div>
                <Btn
                  label="Resolve"
                  color="#a27ef0"
                  onClick={() => setResolving(pr)}
                />
              </div>
            ))
          )}
        </div>
      </Card>
    </>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function LFSCardIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <ellipse cx="8" cy="4.5" rx="5" ry="2" stroke="currentColor" strokeWidth="1.3" />
    <path d="M3 4.5V11.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M13 4.5V11.5" stroke="currentColor" strokeWidth="1.3" />
    <ellipse cx="8" cy="11.5" rx="5" ry="2" stroke="currentColor" strokeWidth="1.3" />
    <ellipse cx="8" cy="8" rx="5" ry="2" stroke="currentColor" strokeWidth="1.3" />
  </svg>
}

function SizeCardIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M8 4v4l2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

function ActivityCardIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <polyline points="1,8 4,4 7,11 10,6 13,9 16,7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

function CommitCardIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M1 8h4.5M10.5 8H15" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
}

function PRCardIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <circle cx="4" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="4" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="12" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M4 5.5v5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <path d="M12 10.5V8a2 2 0 0 0-2-2H7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <path d="M6 5.5L4 3.5 2 5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function OverviewPanel({ repoPath, onNavigate, onRefresh }: OverviewPanelProps) {
  const { fileStatus } = useRepoStore()

  const [sync,       setSync]       = useState<SyncStatus     | null>(null)
  const [lfs,        setLfs]        = useState<LFSStatus      | null>(null)
  const [size,       setSize]       = useState<SizeBreakdown  | null>(null)
  const [locks,      setLocks]      = useState<number>(0)
  const [activity,   setActivity]   = useState<BranchActivity[]>([])
  const [commits,    setCommits]    = useState<CommitEntry[]>([])
  const [branch,     setBranch]     = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdate, setLastUpdate] = useState<number | null>(null)
  const [prs,        setPrs]        = useState<PullRequest[]>([])
  const [prsError,   setPrsError]   = useState<string | null>(null)
  const [ghSlug,     setGhSlug]     = useState<string | null>(null)
  const [sizeLoading, setSizeLoading] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const loadAll = useCallback(async () => {
    setRefreshing(true)
    const [branchR, syncR, lfsR, locksR, activityR, commitsR, remoteUrlR] = await Promise.allSettled([
      ipc.currentBranch(repoPath),
      ipc.getSyncStatus(repoPath),
      ipc.lfsStatus(repoPath),
      ipc.listLocks(repoPath),
      ipc.gitBranchActivity(repoPath),
      ipc.log(repoPath, { limit: 20 }),
      ipc.getRemoteUrl(repoPath),
    ])
    if (!mounted.current) return
    if (branchR.status   === 'fulfilled') setBranch(branchR.value)
    if (syncR.status     === 'fulfilled') setSync(syncR.value)
    if (lfsR.status      === 'fulfilled') setLfs(lfsR.value)
    if (locksR.status    === 'fulfilled') setLocks(locksR.value.length)
    if (activityR.status === 'fulfilled') setActivity(activityR.value)
    if (commitsR.status  === 'fulfilled') setCommits(commitsR.value)

    setLastUpdate(Date.now())
    setRefreshing(false)

    if (remoteUrlR.status === 'fulfilled' && remoteUrlR.value) {
      const slug = parseGitHubSlug(remoteUrlR.value)
      setGhSlug(slug)
      if (slug) {
        const [owner, repo] = slug.split('/')
        try {
          const prList = await ipc.githubListPRs({ owner, repo })
          if (mounted.current) { setPrs(prList); setPrsError(null) }
        } catch (err: any) {
          if (mounted.current) setPrsError(err?.message ?? 'Failed to load pull requests')
        }
      }
    }
  }, [repoPath])

  // Refresh when history or PR state changes (fetch, pull, push, PR merge/close, branch switch)
  const historyTick    = useRepoStore(s => s.historyTick)
  const prTick         = useRepoStore(s => s.prTick)
  const historyTickRef = useRef(historyTick)
  const prTickRef      = useRef(prTick)
  const loadAllRef     = useRef(loadAll)
  useEffect(() => { loadAllRef.current = loadAll }, [loadAll])
  useEffect(() => {
    if (historyTick === historyTickRef.current && prTick === prTickRef.current) return
    historyTickRef.current = historyTick
    prTickRef.current = prTick
    loadAllRef.current()
  }, [historyTick, prTick])

  const loadSize = useCallback(async () => {
    if (!mounted.current) return
    setSizeLoading(true)
    try {
      const s = await ipc.cleanupSize(repoPath)
      if (mounted.current) setSize(s)
    } catch { }
    finally { if (mounted.current) setSizeLoading(false) }
  }, [repoPath])

  useEffect(() => {
    const t = setTimeout(loadSize, 800)
    return () => clearTimeout(t)
  }, [loadSize])

  useEffect(() => { loadAll() }, [loadAll])

  const stagedCount   = React.useMemo(() => fileStatus.filter(f =>  f.staged).length, [fileStatus])
  const unstagedCount = React.useMemo(() => fileStatus.filter(f => !f.staged).length, [fileStatus])

  const { syncDot, syncLabel, changesDot, changesLabel, locksDot, locksLabel, lfsWarnDot, lfsLabel, sizeDot, sizeLabel } =
    React.useMemo(() => {
      const sd = !sync ? '#344057'
        : sync.behind > 0 ? '#f5a832'
        : sync.ahead  > 0 ? '#e8622f'
        : '#2dbd6e'
      const sl = !sync             ? 'No upstream'
        : sync.behind > 0 && sync.ahead > 0 ? `↑${sync.ahead} ↓${sync.behind}`
        : sync.behind > 0                   ? `↓${sync.behind} behind`
        : sync.ahead  > 0                   ? `↑${sync.ahead} to push`
        : 'In sync'
      const total = stagedCount + unstagedCount
      return {
        syncDot: sd, syncLabel: sl,
        changesDot:   total > 0 ? '#f5a832' : '#2dbd6e',
        changesLabel: total === 0 ? 'Clean' : `${total} change${total !== 1 ? 's' : ''}`,
        locksDot:   locks > 0 ? '#e8622f' : '#344057',
        locksLabel: locks === 0 ? 'No locks' : `${locks} lock${locks !== 1 ? 's' : ''}`,
        lfsWarnDot: (lfs?.untracked.length ?? 0) > 0 ? '#f5a832' : lfs ? '#2dbd6e' : '#344057',
        lfsLabel:   !lfs ? 'LFS —' : (lfs.untracked.length > 0 ? `⚠ ${lfs.untracked.length} untracked` : 'LFS OK'),
        sizeDot:    !size ? '#344057'
          : size.totalBytes > 5 * 1_073_741_824 ? '#e84545'
          : size.totalBytes > 2 * 1_073_741_824 ? '#f5a832'
          : '#344057',
        sizeLabel: sizeLoading ? 'Measuring…' : size ? fmtBytes(size.totalBytes) : 'Size —',
      }
    }, [sync, stagedCount, unstagedCount, locks, lfs, size, sizeLoading])

  const warnings = React.useMemo(() => {
    const w: { msg: string; color: string }[] = []
    if (sync && sync.behind > 0)
      w.push({ msg: `${sync.behind} commit${sync.behind !== 1 ? 's' : ''} behind ${sync.remoteName}/${sync.remoteBranch}`, color: sync.behind > 5 ? '#e84545' : '#f5a832' })
    if ((lfs?.untracked.length ?? 0) > 0)
      w.push({ msg: `${lfs!.untracked.length} large file${lfs!.untracked.length !== 1 ? 's' : ''} not tracked in LFS`, color: '#f5a832' })
    if (size && size.totalBytes > 5 * 1_073_741_824)
      w.push({ msg: `Repository is ${fmtBytes(size.totalBytes)} — consider cleanup`, color: '#f5a832' })
    if (sync && !sync.hasUpstream)
      w.push({ msg: 'Branch has no remote upstream configured', color: '#344057' })
    return w
  }, [sync, lfs, size])

  const repoName = React.useMemo(() => repoPath.split(/[/\\]/).pop() ?? repoPath, [repoPath])

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: '#0d0f15' }}>
      <div style={{ padding: 18, minWidth: 640, display: 'flex', flexDirection: 'column', gap: 14, animation: 'fade-in 0.25s ease both' }}>

        {/* ── Header ───────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 17, fontWeight: 700, color: '#e2e6f4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '-0.02em' }}>
              {repoName}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 3 }}>
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><circle cx="3" cy="3" r="2" stroke="#4a9eff" strokeWidth="1.2"/><circle cx="3" cy="9" r="2" stroke="#4a9eff" strokeWidth="1.2"/><path d="M3 5v2M9 6c0-1.7-1.3-3-3-3" stroke="#4a9eff" strokeWidth="1.1" strokeLinecap="round"/></svg>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#4a9eff' }}>{branch || '—'}</span>
              <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#1e2a3a' }}>·</span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: '#283047', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {repoPath}
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {lastUpdate && (
              <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#283047' }}>
                {timeAgoMs(lastUpdate)}
              </span>
            )}
            <button
              onClick={() => { loadAll(); onRefresh() }}
              disabled={refreshing}
              style={{
                height: 28, paddingLeft: 12, paddingRight: 12, borderRadius: 6,
                background: 'rgba(255,255,255,0.02)', border: '1px solid #1a2030',
                color: refreshing ? '#344057' : '#5a6880',
                fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11.5,
                cursor: refreshing ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', gap: 5,
              }}
              onMouseEnter={e => { if (!refreshing) { e.currentTarget.style.borderColor = '#e8622f'; e.currentTarget.style.color = '#e8622f' } }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#1a2030'; e.currentTarget.style.color = refreshing ? '#344057' : '#5a6880' }}
            >
              <span style={{ fontSize: 14 }}>{refreshing ? '…' : '↺'}</span>
              Refresh
            </button>
          </div>
        </div>

        {/* ── Health status strip ───────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <StatusChip dot={syncDot}   label={syncLabel}    onClick={() => {}} />
          <StatusChip dot={changesDot} label={changesLabel} onClick={() => onNavigate('changes')} />
          <StatusChip dot={locksDot}   label={locksLabel}   />
          <StatusChip dot={lfsWarnDot} label={lfsLabel}     onClick={() => onNavigate('lfs')} />
          <StatusChip dot={sizeDot}    label={sizeLabel}    onClick={() => onNavigate('cleanup')} />
        </div>

        {/* ── Warnings ─────────────────────────────────────────────────────── */}
        {warnings.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {warnings.map((w, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 11px', borderRadius: 7,
                background: `${w.color}09`, border: `1px solid ${w.color}28`,
                boxShadow: `0 0 12px ${w.color}0c`,
              }}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ color: w.color, flexShrink: 0 }}>
                  <path d="M8 2 L14.5 13.5 H1.5 Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                  <path d="M8 6.5v3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  <circle cx="8" cy="11.5" r="0.8" fill="currentColor" />
                </svg>
                <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11.5, color: w.color }}>{w.msg}</span>
              </div>
            ))}
          </div>
        )}

        {/* ── Pull Request Management (top priority) ────────────────────────── */}
        <AdminPRsCard
          prs={prs}
          ghSlug={ghSlug}
          repoPath={repoPath}
          loading={refreshing}
          error={prsError}
          onRefresh={loadAll}
        />

        {/* ── Row 1: LFS Health | Repository Size ──────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <LfsCard lfs={lfs} onNavigate={onNavigate} />
          <SizeCard size={size} sizeLoading={sizeLoading} onNavigate={onNavigate} />
        </div>

        {/* ── Row 2: Recent Commits | Branch Activity ───────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 14, alignItems: 'start' }}>
          <CommitsCard commits={commits} onNavigate={onNavigate} />
          <ActivityCard activity={activity} onNavigate={onNavigate} />
        </div>

      </div>
    </div>
  )
}

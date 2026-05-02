import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ipc, SyncStatus, Lock, FileStatus, PullRequest } from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { useAuthStore } from '@/stores/authStore'
import { useOperationStore } from '@/stores/operationStore'
import { useLockStore } from '@/stores/lockStore'
import { usePRStore } from '@/stores/prStore'
import { ContributionGraph } from './ContributionGraph'
import { getLastFetch, markFetchPerformed, onFetchPerformed } from '@/lib/fetchState'
import { canCreatePR, canPull, canPush, fetchButtonLabel, pullButtonLabel, pushButtonLabel } from '@/lib/syncButtonLogic'
import { getTopBarSyncHandlers, getTopBarSyncSnapshot, onTopBarSyncChanged } from '@/lib/topBarSyncBridge'

const sessionFetchedRepos = new Set<string>()
const sessionRemoteUrls   = new Map<string, string | null>()

interface DashboardPanelProps {
  repoPath: string
  onNavigate: (tab: string) => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const LAST_PULL_KEY  = (p: string) => `lucid-git:last-pull:${p}`

function greeting(): string {
  const h = new Date().getHours()
  if (h >= 5  && h < 12) return 'Good morning'
  if (h >= 12 && h < 18) return 'Good afternoon'
  return 'Good evening'
}

function parseFirstName(login: string): string {
  const word = login.split(/[_.\-@]/)[0]
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function timeAgo(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 60)     return 'just now'
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(ts).toLocaleDateString()
}

function timeAgoStr(iso: string): string { return timeAgo(new Date(iso).getTime()) }

function authorColor(name: string): string {
  const palette = ['#4a9eff', '#a27ef0', '#2dbd6e', '#f5a832', '#e8622f', '#1abc9c', '#e91e63']
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return parts.length >= 2 ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase() : name.slice(0, 2).toUpperCase()
}

function parseGitHubSlug(url: string): string | null {
  const m = url.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)
  return m ? m[1] : null
}


function fileStatusLabel(f: FileStatus): { char: string; color: string } {
  if (f.staged) {
    if (f.indexStatus === 'A') return { char: 'A', color: '#2dbd6e' }
    if (f.indexStatus === 'D') return { char: 'D', color: '#e84040' }
    return { char: 'M', color: '#4a9eff' }
  }
  if (f.workingStatus === '?') return { char: '?', color: '#344057' }
  if (f.workingStatus === 'D') return { char: 'D', color: '#e84040' }
  return { char: 'M', color: '#f5a832' }
}

// ── Main Component ────────────────────────────────────────────────────────────

export function DashboardPanel({ repoPath, onNavigate }: DashboardPanelProps) {
  const { currentBranch, fileStatus, syncTick, bumpHistoryTick } = useRepoStore()
  const { accounts, currentAccountId } = useAuthStore()
  const isAdmin = useAuthStore(s => s.isAdmin(repoPath))
  const opRun = useOperationStore(s => s.run)
  const { locks, unlockFile } = useLockStore()
  const openPRDialog = usePRStore(s => s.openDialog)

  const [sync,      setSync]      = useState<SyncStatus | null>(null)
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null)
  const [busy,      setBusy]      = useState<string | null>(null)
  const [topBarTick, setTopBarTick] = useState(0)
  const [lastPull,  setLastPull]  = useState<number | null>(null)
  const [lastFetch, setLastFetch] = useState<number | null>(null)
  const [hasFetched, setHasFetched] = useState(() => sessionFetchedRepos.has(repoPath))
  const syncTickRef = useRef(syncTick)

  const staged       = React.useMemo(() => fileStatus.filter(f =>  f.staged).length,  [fileStatus])
  const unstaged     = React.useMemo(() => fileStatus.filter(f => !f.staged).length,  [fileStatus])
  const currentLogin = React.useMemo(
    () => accounts.find(a => a.userId === currentAccountId)?.login ?? null,
    [accounts, currentAccountId]
  )
  const repoName = React.useMemo(() => repoPath.replace(/\\/g, '/').split('/').pop() ?? repoPath, [repoPath])
  const ghSlug   = React.useMemo(() => remoteUrl ? parseGitHubSlug(remoteUrl) : null, [remoteUrl])

  const loadSync = useCallback(async () => {
    try { setSync(await ipc.getSyncStatus(repoPath)) } catch { setSync(null) }
  }, [repoPath])

  const reload = useCallback(() => {
    loadSync()
  }, [repoPath, loadSync])

  useEffect(() => {
    reload()
    // Use session cache so remoteUrl isn't re-read from git on every tab switch
    if (sessionRemoteUrls.has(repoPath)) {
      setRemoteUrl(sessionRemoteUrls.get(repoPath) ?? null)
    } else {
      ipc.getRemoteUrl(repoPath)
        .then(url => { sessionRemoteUrls.set(repoPath, url); setRemoteUrl(url) })
        .catch(() => { sessionRemoteUrls.set(repoPath, null) })
    }
    const storedPull  = localStorage.getItem(LAST_PULL_KEY(repoPath))
    const storedFetch = getLastFetch(repoPath)
    setLastPull(storedPull   ? parseInt(storedPull,  10) : null)
    setLastFetch(storedFetch)
    setHasFetched(sessionFetchedRepos.has(repoPath))
  }, [repoPath])


  useEffect(() => onTopBarSyncChanged(() => setTopBarTick(t => t + 1)), [])

  useEffect(() => {
    return onFetchPerformed((path, at) => {
      if (path !== repoPath) return
      setLastFetch(at)
      sessionFetchedRepos.add(path)
      setHasFetched(true)
    })
  }, [repoPath])

  // Refresh sync status when a history operation (undo, reset, revert, cherry-pick) changes local HEAD
  useEffect(() => {
    if (syncTick === syncTickRef.current) return
    syncTickRef.current = syncTick
    loadSync()
  }, [syncTick, loadSync])

  const topBarSnapshot = getTopBarSyncSnapshot()
  const topBarHandlers = getTopBarSyncHandlers()
  const usingTopBarState = topBarSnapshot.repoPath === repoPath

  const doFetch = async () => {
    if (usingTopBarState && topBarHandlers) return void topBarHandlers.fetch()
    setBusy('fetch')
    try {
      await opRun('Fetching…', () => ipc.fetch(repoPath))
      const now = markFetchPerformed(repoPath)
      setLastFetch(now)
      sessionFetchedRepos.add(repoPath)
      setHasFetched(true)
      await loadSync()
      bumpHistoryTick()
    } finally { setBusy(null) }
  }

  const doPull = async () => {
    if (usingTopBarState && topBarHandlers) return void topBarHandlers.pull()
    setBusy('pull')
    try {
      await opRun('Pulling…', () => ipc.pull(repoPath))
      const now = Date.now()
      localStorage.setItem(LAST_PULL_KEY(repoPath), String(now))
      setLastPull(now)
      await loadSync()
      bumpHistoryTick()
    } finally { setBusy(null) }
  }

  const doPush = async () => {
    if (usingTopBarState && topBarHandlers) return void topBarHandlers.push()
    setBusy('push')
    try {
      await opRun('Pushing…', () => ipc.push(repoPath))
      await loadSync()
      bumpHistoryTick()
    } finally { setBusy(null) }
  }

  const effectiveSync = usingTopBarState ? topBarSnapshot.sync : sync
  const effectiveHasFetched = usingTopBarState ? topBarSnapshot.hasFetched : hasFetched
  const effectiveBusy = usingTopBarState
    ? (topBarSnapshot.syncOp === 'idle' ? 'idle' : topBarSnapshot.syncOp === 'fetching' ? 'fetch' : topBarSnapshot.syncOp === 'pulling' ? 'pull' : 'push')
    : (busy ?? 'idle')

  const TWO_DAYS  = 2 * 24 * 60 * 60 * 1000
  const behind    = effectiveSync?.behind ?? 0
  const ahead     = effectiveSync?.ahead ?? 0
  const busyState = effectiveBusy
  const canCreatePRNow = canCreatePR(!!ghSlug, !!currentBranch, ahead, busyState)
  const stalePull = behind > 0 && (lastPull === null || Date.now() - lastPull > TWO_DAYS)
  void topBarTick

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: '#0d0f15', padding: '22px 24px', fontFamily: "'IBM Plex Sans', system-ui", display: 'flex', flexDirection: 'column', minHeight: '100%' }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#c8d0e8', letterSpacing: '-0.03em', lineHeight: 1 }}>
            {greeting()}{currentLogin ? `, ${parseFirstName(currentLogin)}` : ''}
          </div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#344057', marginTop: 5 }}>
            {currentBranch || 'no branch'} · {repoName}
          </div>
        </div>
        <button
          onClick={reload}
          style={{ display: 'flex', alignItems: 'center', gap: 5, height: 26, padding: '0 10px', borderRadius: 5, border: '1px solid #1a2030', background: 'transparent', color: '#344057', fontSize: 11, cursor: 'pointer', fontFamily: "'IBM Plex Sans', system-ui" }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#283047'; e.currentTarget.style.color = '#5a6880' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#1a2030'; e.currentTarget.style.color = '#344057' }}
        >
          <RefreshIcon /> Refresh
        </button>
      </div>

      {/* ── Stale-pull warning ─────────────────────────────────────────── */}
      {stalePull && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18,
          padding: '10px 16px', borderRadius: 8,
          background: 'rgba(245,168,50,0.05)', border: '1px solid rgba(245,168,50,0.18)',
        }}>
          <span style={{ fontSize: 15, flexShrink: 0, color: '#f5a832' }}>⚠</span>
          <div style={{ flex: 1 }}>
            <span style={{ fontSize: 12.5, color: '#f5a832', fontWeight: 600 }}>
              {behind} commit{behind !== 1 ? 's' : ''} behind {effectiveSync?.remoteName ?? 'remote'}
            </span>
            <span style={{ fontSize: 11.5, color: '#5a6880', marginLeft: 8 }}>
              {lastPull === null ? "Haven't pulled yet" : `Last pulled ${timeAgo(lastPull)}`}
            </span>
          </div>
          <SmallBtn label={pullButtonLabel(busyState)} color="#f5a832" disabled={!canPull(hasFetched, busyState)} onClick={doPull} />
        </div>
      )}

      {/* ── Suggestions + Contribution Graph ─────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr', gap: 14, marginBottom: 14 }}>
        <SuggestionsCard
          lastFetch={lastFetch}
          lastPull={lastPull}
          sync={effectiveSync}
          fileStatus={fileStatus}
          onFetch={doFetch}
          busy={busyState === 'idle' ? null : busyState}
        />
        <ContributionGraph repoPath={repoPath} />
      </div>

      {/* ── Daily Flow Guide ───────────────────────────────────────────── */}
      <DailyFlowStrip
        sync={effectiveSync}
        staged={staged}
        unstaged={unstaged}
        busy={busyState === 'idle' ? null : busyState}
        hasFetched={effectiveHasFetched}
        ghSlug={ghSlug}
        currentBranch={currentBranch}
        onFetch={doFetch}
        onPull={doPull}
        onPush={doPush}
        onGoChanges={() => onNavigate('timeline')}
        canCreatePR={canCreatePRNow}
        onOpenPR={() => usingTopBarState && topBarHandlers ? topBarHandlers.createPR() : (remoteUrl && canCreatePRNow && openPRDialog(repoPath, currentBranch, remoteUrl))}
      />

      {/* ── Status grid (3 columns) ─────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gridAutoRows: '1fr', gap: 14, marginTop: 16, flex: 1, minHeight: 300 }}>
        <LocalStatusCard
          sync={effectiveSync} busy={busyState} hasFetched={effectiveHasFetched} files={fileStatus}
          staged={staged} unstaged={unstaged}
          onFetch={doFetch} onPull={doPull} onPush={doPush} onNavigate={onNavigate}
        />
        <LocksCard locks={locks} currentLogin={currentLogin} repoPath={repoPath} unlockFile={unlockFile} isAdmin={isAdmin} />
        <PRsCard ghSlug={ghSlug} />
      </div>

    </div>
  )
}

// ── Daily Flow Strip ──────────────────────────────────────────────────────────

type StepState = 'done' | 'warn' | 'action' | 'neutral'

interface FlowStepBtn {
  label: string; color?: string; disabled: boolean; onClick: () => void
}

interface FlowStepDef {
  n: number
  label: string
  sub: string
  state: StepState
  btns?: FlowStepBtn[]
}

function DailyFlowStrip({
  sync, staged, unstaged, busy, hasFetched, ghSlug, currentBranch,
  onFetch, onPull, onPush, onGoChanges, onOpenPR, canCreatePR,
}: {
  sync: SyncStatus | null
  staged: number; unstaged: number
  busy: 'idle' | 'fetch' | 'pull' | 'push'
  hasFetched: boolean
  ghSlug: string | null
  currentBranch: string
  onFetch: () => void; onPull: () => void; onPush: () => void
  onGoChanges: () => void; onOpenPR: () => void; canCreatePR: boolean
}) {
  const behind     = sync?.behind ?? 0
  const ahead      = sync?.ahead  ?? 0
  const hasChanges = staged + unstaged > 0

  let syncState: StepState   = 'done'
  let syncSub                = 'In sync with remote'

  if (behind > 0 && ahead > 0) {
    syncState = 'warn'
    syncSub   = `${behind} behind · ${ahead} ahead`
  } else if (behind > 0) {
    syncState = 'warn'
    syncSub   = `${behind} commit${behind !== 1 ? 's' : ''} behind remote`
  } else if (ahead > 0) {
    syncState = 'action'
    syncSub   = `${ahead} commit${ahead !== 1 ? 's' : ''} ready to push`
  }

  const isBusy = !!busy

  const s1Btns: FlowStepBtn[] = [
    {
      label:    fetchButtonLabel(busy),
      color:    '#4a9eff',
      disabled: isBusy,
      onClick:  onFetch,
    },
    {
      label:    pullButtonLabel(busy),
      color:    '#f5a832',
      disabled: !canPull(hasFetched, busy),
      onClick:  onPull,
    },
  ]

  const steps: FlowStepDef[] = [
    {
      n: 1, label: 'Sync',
      sub: syncSub,
      state: syncState,
      btns: s1Btns,
    },
    {
      n: 2, label: 'Work & Commit',
      sub: hasChanges
        ? `${staged > 0 ? `${staged} staged` : ''}${staged > 0 && unstaged > 0 ? ' · ' : ''}${unstaged > 0 ? `${unstaged} modified` : ''}`
        : 'Working directory clean',
      state: hasChanges ? 'action' : 'done',
      btns: hasChanges ? [{ label: 'View Changes', color: '#4a9eff', disabled: false, onClick: onGoChanges }] : undefined,
    },
    {
      n: 3, label: 'Open PR',
      sub: ghSlug
        ? `Merge ${currentBranch} into ${sync?.remoteBranch ?? 'main'}`
        : 'No GitHub remote detected',
      state: 'neutral',
      btns: ghSlug ? [{ label: 'Create PR', color: '#a78bfa', disabled: !canCreatePR, onClick: onOpenPR }] : undefined,
    },
  ]

  return (
    <div style={{
      display: 'flex', alignItems: 'stretch',
      background: '#131720', border: '1px solid #1a2030', borderRadius: 10,
      overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    }}>
      {steps.map((step, i) => (
        <React.Fragment key={step.n}>
          {i > 0 && <div style={{ width: 1, background: '#1a2030', alignSelf: 'stretch', flexShrink: 0 }} />}
          <FlowStep step={step} />
        </React.Fragment>
      ))}
    </div>
  )
}

function FlowStep({ step }: { step: FlowStepDef }) {
  const stateStyle: Record<StepState, { dot: string; accent: string; glow: string; bg: string }> = {
    neutral: { dot: '#252e42', accent: '#5a6880', glow: 'transparent',           bg: 'transparent' },
    done:    { dot: '#2dbd6e', accent: '#2dbd6e', glow: 'rgba(45,189,110,0.08)', bg: 'rgba(45,189,110,0.03)' },
    warn:    { dot: '#f5a832', accent: '#f5a832', glow: 'rgba(245,168,50,0.08)', bg: 'rgba(245,168,50,0.04)' },
    action:  { dot: '#4a9eff', accent: '#4a9eff', glow: 'rgba(74,158,255,0.08)', bg: 'rgba(74,158,255,0.03)' },
  }
  const s           = stateStyle[step.state]
  const highlighted = step.state !== 'neutral'

  return (
    <div style={{ flex: 1, padding: '14px 16px 12px', background: s.bg, boxShadow: highlighted ? `inset 0 0 20px ${s.glow}` : 'none', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
        <div style={{
          width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: highlighted ? `${s.dot}22` : '#151b27',
          border: `1.5px solid ${highlighted ? `${s.dot}66` : '#1d2535'}`,
          fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700,
          color: highlighted ? s.dot : '#2a3348',
          boxShadow: highlighted ? `0 0 8px ${s.dot}44` : 'none',
        }}>
          {step.state === 'done' ? '✓' : step.n}
        </div>
        <span style={{ fontSize: 12.5, fontWeight: highlighted ? 600 : 500, color: highlighted ? s.accent : '#5a6880', letterSpacing: '-0.01em' }}>
          {step.label}
        </span>
      </div>

      {/* No truncation — text wraps freely */}
      <div style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5,
        color: highlighted ? `${s.accent}99` : '#283047',
        marginBottom: step.btns?.length ? 10 : 2, marginLeft: 27, lineHeight: 1.5,
      }}>
        {step.sub}
      </div>

      {step.btns && step.btns.length > 0 && (
        <div style={{ marginLeft: 27, display: 'flex', gap: 6 }}>
          {step.btns.map((b, i) => (
            <SmallBtn key={i} label={b.label} color={b.color} disabled={b.disabled} onClick={b.onClick} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Suggestions Card ──────────────────────────────────────────────────────────

type SuggestionUrgency = 'ok' | 'tip' | 'warn' | 'high' | 'critical'

interface Suggestion {
  urgency: SuggestionUrgency
  text: string
  action?: { label: string; onClick: () => void; disabled: boolean }
}

const URGENCY_COLOR: Record<SuggestionUrgency, { dot: string; bg: string; border: string; text: string }> = {
  ok:       { dot: '#2dbd6e', bg: 'rgba(45,189,110,0.04)',  border: 'rgba(45,189,110,0.12)',  text: '#4a7a60'  },
  tip:      { dot: '#4a9eff', bg: 'rgba(74,158,255,0.04)',  border: 'rgba(74,158,255,0.12)',  text: '#6a849a'  },
  warn:     { dot: '#f5a832', bg: 'rgba(245,168,50,0.05)',  border: 'rgba(245,168,50,0.18)',  text: '#b08040'  },
  high:     { dot: '#e8622f', bg: 'rgba(232,98,47,0.06)',   border: 'rgba(232,98,47,0.20)',   text: '#b06040'  },
  critical: { dot: '#e84545', bg: 'rgba(232,69,69,0.08)',   border: 'rgba(232,69,69,0.28)',   text: '#c05050'  },
}

function SuggestionsCard({ lastFetch, lastPull, sync, fileStatus, onFetch, busy }: {
  lastFetch: number | null
  lastPull: number | null
  sync: SyncStatus | null
  fileStatus: FileStatus[]
  onFetch: () => void
  busy: 'idle' | 'fetch' | 'pull' | 'push'
}) {
  const h            = new Date().getHours()
  const lastSyncTime = (lastFetch !== null || lastPull !== null)
    ? Math.max(lastFetch ?? 0, lastPull ?? 0)
    : null
  const sinceMs    = lastSyncTime !== null ? Date.now() - lastSyncTime : null
  const sinceHours = sinceMs !== null ? sinceMs / 3_600_000 : null
  const sinceDays  = sinceMs !== null ? sinceMs / 86_400_000 : null
  const aheadCount = sync?.ahead ?? 0
  const hasWork    = fileStatus.some(f => f.staged || f.workingStatus === 'M' || f.workingStatus === 'A' || f.workingStatus === '?')

  const suggestions: Suggestion[] = []

  // ── Sync age ──────────────────────────────────────────────────────────────
  if (lastSyncTime === null) {
    suggestions.push({
      urgency: 'high',
      text: "You haven't synced with the remote yet. Fetch now to see if your teammates have pushed new commits.",
      action: { label: 'Fetch Now', onClick: onFetch, disabled: !!busy },
    })
  } else if (sinceDays! >= 2) {
    const d = Math.floor(sinceDays!)
    suggestions.push({
      urgency: 'critical',
      text: `Last synced ${d} day${d !== 1 ? 's' : ''} ago — you may be significantly out of date with your team. Fetch and pull before continuing work to avoid difficult merge conflicts.`,
      action: { label: 'Fetch Now', onClick: onFetch, disabled: !!busy },
    })
  } else if (sinceHours! >= 8) {
    const hrs = Math.floor(sinceHours!)
    suggestions.push({
      urgency: 'warn',
      text: `${hrs} hour${hrs !== 1 ? 's' : ''} since last sync — consider fetching to check whether teammates have pushed new commits since then.`,
      action: { label: 'Fetch', onClick: onFetch, disabled: !!busy },
    })
  } else if (sinceHours! >= 4) {
    const hrs = Math.floor(sinceHours!)
    suggestions.push({
      urgency: 'tip',
      text: `${hrs} hour${hrs !== 1 ? 's' : ''} since last sync. Nothing urgent, but a quick fetch keeps you current with the team.`,
    })
  } else {
    suggestions.push({
      urgency: 'ok',
      text: `Last synced ${timeAgo(lastSyncTime)} — you are up to date with the remote.`,
    })
  }

  // ── Morning tip ───────────────────────────────────────────────────────────
  if (h >= 5 && h < 12 && (lastSyncTime === null || sinceHours! > 1)) {
    suggestions.push({
      urgency: 'tip',
      text: 'Morning tip: Start your day with a sync to pick up any commits your teammates pushed overnight.',
    })
  }

  // ── Evening tip ───────────────────────────────────────────────────────────
  if (h >= 17 && h < 22) {
    if (aheadCount > 0) {
      suggestions.push({
        urgency: 'tip',
        text: `End of day: You have ${aheadCount} unpushed commit${aheadCount !== 1 ? 's' : ''}. Push before you finish so your team has your latest work.`,
      })
    } else if (hasWork) {
      suggestions.push({
        urgency: 'tip',
        text: 'End of day: You have local changes. Consider committing your work in progress and pushing before you wrap up.',
      })
    }
  }

  return (
    <Card title="Suggestions" icon={<SuggestionsIcon />}>
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', flex: 1 }}>
        {suggestions.map((s, i) => {
          const uc = URGENCY_COLOR[s.urgency]
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 7, background: uc.bg, border: `1px solid ${uc.border}` }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: uc.dot, marginTop: 5, boxShadow: `0 0 6px ${uc.dot}66` }} />
              <div style={{ flex: 1 }}>
                <p style={{ margin: 0, fontSize: 12, lineHeight: 1.65, color: uc.text, fontFamily: "'IBM Plex Sans', system-ui" }}>
                  {s.text}
                </p>
                {s.action && (
                  <div style={{ marginTop: 8 }}>
                    <SmallBtn label={s.action.label} color={uc.dot} disabled={s.action.disabled} onClick={s.action.onClick} />
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ── Local Status Card (sync + changes combined) ───────────────────────────────

function LocalStatusCard({ sync, busy, hasFetched, files, staged, unstaged, onFetch, onPull, onPush, onNavigate }: {
  sync: SyncStatus | null; busy: string | null; hasFetched: boolean
  files: FileStatus[]; staged: number; unstaged: number
  onFetch: () => void; onPull: () => void; onPush: () => void
  onNavigate: (tab: string) => void
}) {
  const behind      = sync?.behind ?? 0
  const ahead       = sync?.ahead  ?? 0
  const clean       = sync && behind === 0 && ahead === 0
  const pushEnabled = canPush(hasFetched, behind, ahead, busy)
  const total       = staged + unstaged
  const preview     = files.slice(0, 4)

  return (
    <Card title="Local Status" icon={<SyncIcon />} onAction={() => onNavigate('timeline')} actionLabel="View All">
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 9, overflowY: 'auto', flex: 1, minHeight: 0 }}>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#344057', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sync?.hasUpstream ? `→ ${sync.remoteName}/${sync.remoteBranch}` : 'No upstream configured'}
        </div>

        <div style={{ display: 'flex', gap: 14 }}>
          <StatPill icon="↑" value={sync?.ahead  ?? '—'} label="ahead"  color={ahead  > 0 ? '#e8622f' : '#283047'} />
          <StatPill icon="↓" value={sync?.behind ?? '—'} label="behind" color={behind > 0 ? '#f5a832' : '#283047'} />
        </div>

        {clean && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#2dbd6e', fontSize: 12 }}>✓</span>
            <span style={{ fontSize: 11.5, color: '#344057' }}>In sync with remote</span>
          </div>
        )}

        <div style={{ display: 'flex', gap: 6 }}>
          <SmallBtn label={fetchButtonLabel(busy)} color="#4a9eff" disabled={busy !== 'idle'} onClick={onFetch} />
          <SmallBtn label={pullButtonLabel(busy)} color="#f5a832" disabled={!canPull(hasFetched, busy)} onClick={onPull} />
          <SmallBtn label={pushButtonLabel(busy)} color={pushEnabled ? '#2dbd6e' : undefined} disabled={!pushEnabled} onClick={onPush} />
        </div>

        <div style={{ height: 1, background: '#1a2030', marginLeft: -14, marginRight: -14 }} />

        <div style={{ display: 'flex', gap: 12 }}>
          <StatPill icon="●" value={staged}   label="staged"   color={staged   > 0 ? '#2dbd6e' : '#283047'} />
          <StatPill icon="○" value={unstaged} label="modified" color={unstaged > 0 ? '#f5a832' : '#283047'} />
        </div>

        {total === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#2dbd6e', fontSize: 12 }}>✓</span>
            <span style={{ fontSize: 11.5, color: '#344057' }}>Working directory clean</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {preview.map(f => {
              const { char, color } = fileStatusLabel(f)
              const name = f.path.replace(/\\/g, '/').split('/').pop() ?? f.path
              return (
                <div key={f.path} style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                  <span style={{
                    fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700,
                    color, background: `${color}18`, border: `1px solid ${color}33`,
                    borderRadius: 3, padding: '0 4px', flexShrink: 0, lineHeight: '14px',
                  }}>{char}</span>
                  <span style={{
                    fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: '#5a6880',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                  }} title={f.path}>{name}</span>
                </div>
              )
            })}
            {files.length > 4 && (
              <button onClick={() => onNavigate('timeline')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', marginTop: 2 }}>
                <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#344057' }}>
                  +{files.length - 4} more files…
                </span>
              </button>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

// ── Active Locks Card ─────────────────────────────────────────────────────────

function LocksCard({ locks, currentLogin, repoPath, unlockFile, isAdmin }: {
  locks: Lock[]
  currentLogin: string | null
  repoPath: string
  unlockFile: (repoPath: string, filePath: string, force?: boolean) => Promise<void>
  isAdmin: boolean
}) {
  const [tab, setTab]           = useState<'mine' | 'team'>('mine')
  const [unlocking, setUnlocking] = useState<string | null>(null)

  const myLocks   = locks.filter(l => currentLogin && l.owner.login === currentLogin)
  const teamLocks = locks.filter(l => !currentLogin || l.owner.login !== currentLogin)
  const shown     = tab === 'mine' ? myLocks : teamLocks

  const doUnlock = async (lock: Lock, force: boolean) => {
    setUnlocking(lock.path)
    try { await unlockFile(repoPath, lock.path, force) } catch { /* best-effort */ }
    finally { setUnlocking(null) }
  }

  return (
    <Card title="Active Locks" icon={<LockCardIcon />}>
      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid #18202e', paddingLeft: 13, background: 'rgba(0,0,0,0.06)', flexShrink: 0 }}>
        {(['mine', 'team'] as const).map(t => {
          const count = t === 'mine' ? myLocks.length : teamLocks.length
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                height: 30, paddingLeft: 12, paddingRight: 12,
                background: 'none', border: 'none', cursor: 'pointer',
                borderBottom: `2px solid ${tab === t ? '#e8622f' : 'transparent'}`,
                color: tab === t ? '#e8622f' : '#4a566a',
                fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, fontWeight: 600,
                letterSpacing: '0.04em', transition: 'color 0.1s',
              }}
            >
              {t === 'mine' ? 'Mine' : 'Team'}
              {count > 0 && (
                <span style={{
                  marginLeft: 5, fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
                  background: tab === t ? 'rgba(232,98,47,0.2)' : '#1a2030',
                  color: tab === t ? '#e8622f' : '#4a566a',
                  borderRadius: 8, padding: '1px 5px',
                }}>{count}</span>
              )}
            </button>
          )
        })}
      </div>

      <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', flex: 1, minHeight: 0 }}>
        {shown.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#2dbd6e', fontSize: 12 }}>✓</span>
            <span style={{ fontSize: 11.5, color: '#344057' }}>
              {tab === 'mine' ? 'No files locked by you' : 'No team locks'}
            </span>
          </div>
        ) : (
          shown.map(lock => {
            const filename  = lock.path.replace(/\\/g, '/').split('/').pop() ?? lock.path
            const isOwn     = currentLogin && lock.owner.login === currentLogin
            const color     = isOwn ? '#4a9eff' : '#7b8499'
            const isBusy    = unlocking === lock.path
            const canUnlock = isOwn || isAdmin
            const force     = !isOwn
            return (
              <div key={lock.id} style={{ display: 'flex', alignItems: 'center', gap: 7, overflow: 'hidden', minHeight: 36, flexShrink: 0 }}>
                <div style={{
                  width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                  background: `${authorColor(lock.owner.name)}22`,
                  border: `1px solid ${authorColor(lock.owner.name)}55`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 7, fontWeight: 700,
                  color: authorColor(lock.owner.name),
                }}>{initials(lock.owner.name)}</div>
                <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={lock.path}>
                    {filename}
                  </div>
                  <div style={{ fontSize: 10, color: '#344057', fontFamily: "'JetBrains Mono', monospace" }}>
                    {lock.owner.login} · {timeAgoStr(lock.lockedAt)}
                  </div>
                </div>
                {canUnlock ? (
                  <button
                    onClick={() => doUnlock(lock, force)}
                    disabled={isBusy}
                    style={{
                      height: 20, padding: '0 7px', borderRadius: 4, flexShrink: 0,
                      background: 'transparent',
                      border: `1px solid ${force ? 'rgba(232,69,69,0.35)' : 'rgba(74,158,255,0.35)'}`,
                      color: force ? '#e84545' : '#4a9eff',
                      fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, fontWeight: 600,
                      cursor: isBusy ? 'default' : 'pointer', opacity: isBusy ? 0.5 : 1,
                    }}
                    onMouseEnter={e => { if (!isBusy) e.currentTarget.style.background = force ? 'rgba(232,69,69,0.1)' : 'rgba(74,158,255,0.1)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                  >
                    {isBusy ? '…' : force ? 'Force' : 'Unlock'}
                  </button>
                ) : (
                  <span style={{
                    fontSize: 8, fontWeight: 700, letterSpacing: '0.06em',
                    background: 'rgba(123,132,153,0.1)', color: '#7b8499',
                    border: '1px solid rgba(123,132,153,0.2)', borderRadius: 3,
                    padding: '1px 5px', flexShrink: 0,
                  }}>{lock.owner.login.slice(0, 4).toUpperCase()}</span>
                )}
              </div>
            )
          })
        )}
      </div>
    </Card>
  )
}


// ── Open PRs Card ─────────────────────────────────────────────────────────────

function PRsCard({ ghSlug }: { ghSlug: string | null }) {
  const [prs, setPrs] = useState<PullRequest[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const prTick = useRepoStore(s => s.prTick)
  const prTickRef = useRef(prTick)

  const load = useCallback(async () => {
    if (!ghSlug) return
    const [owner, repo] = ghSlug.split('/')
    setLoading(true)
    setError(null)
    try {
      setPrs(await ipc.githubListPRs({ owner, repo }))
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load pull requests')
    } finally {
      setLoading(false)
    }
  }, [ghSlug])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (prTick === prTickRef.current) return
    prTickRef.current = prTick
    load()
  }, [prTick, load])

  return (
    <Card title="Active Pull Requests" icon={<PRCardIcon />} onAction={ghSlug ? load : undefined} actionLabel={loading ? '…' : 'Refresh'}>
      <div style={{ padding: '10px 14px', overflowY: 'auto', flex: 1, minHeight: 0 }}>
        {!ghSlug ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0' }}>
            <span style={{ fontSize: 11.5, color: '#344057', fontFamily: "'IBM Plex Sans', system-ui" }}>No GitHub remote detected</span>
          </div>
        ) : error ? (
          <div style={{ padding: '4px 0', fontSize: 12, color: '#e84545', fontFamily: "'IBM Plex Sans', system-ui" }}>
            {error}
          </div>
        ) : loading && prs.length === 0 ? (
          <div style={{ padding: '4px 0', fontSize: 12, color: '#344057', fontFamily: "'IBM Plex Sans', system-ui" }}>
            Loading…
          </div>
        ) : prs.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0' }}>
            <span style={{ color: '#2dbd6e', fontSize: 12 }}>✓</span>
            <span style={{ fontSize: 11.5, color: '#344057', fontFamily: "'IBM Plex Sans', system-ui" }}>No open pull requests</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {prs.map(pr => (
              <button
                key={pr.number}
                onClick={() => ipc.openExternal(pr.htmlUrl)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 10px', borderRadius: 6,
                  background: 'transparent', border: '1px solid transparent',
                  cursor: 'pointer', width: '100%', textAlign: 'left',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.borderColor = '#1a2030' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent' }}
              >
                <span style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 700,
                  color: '#a27ef0', background: 'rgba(162,126,240,0.12)',
                  border: '1px solid rgba(162,126,240,0.25)',
                  borderRadius: 4, padding: '1px 6px', flexShrink: 0, lineHeight: '16px',
                }}>#{pr.number}</span>
                <span style={{
                  fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#c8d0e8',
                  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{pr.title}</span>
                {pr.draft && (
                  <span style={{
                    fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, fontWeight: 700,
                    background: 'rgba(90,104,128,0.12)', color: '#5a6880',
                    border: '1px solid rgba(90,104,128,0.2)', borderRadius: 3, padding: '1px 5px',
                    letterSpacing: '0.05em', flexShrink: 0,
                  }}>DRAFT</span>
                )}
                <span style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5,
                  flexShrink: 0, display: 'flex', alignItems: 'center', gap: 3,
                }}>
                  <span style={{ color: '#4a9eff' }}>{pr.headBranch}</span>
                  <span style={{ color: '#283047' }}>→</span>
                  <span style={{ color: '#344057' }}>{pr.baseBranch}</span>
                </span>
                <span style={{
                  fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10.5, color: '#344057',
                  flexShrink: 0,
                }}>{pr.author} · {timeAgoStr(pr.updatedAt)}</span>
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" style={{ color: '#283047', flexShrink: 0 }}>
                  <path d="M10 2H7M10 2V5M10 2L5 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M5 3H2v7h7V7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}

// ── Shared UI Primitives ──────────────────────────────────────────────────────

function Card({ title, icon, children, onAction, actionLabel }: {
  title: string; icon: React.ReactNode; children: React.ReactNode
  onAction?: () => void; actionLabel?: string
}) {
  return (
    <div style={{
      background: '#131720', border: '1px solid #1a2030', borderRadius: 10,
      boxShadow: '0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.025)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden', height: '100%', minHeight: 0,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, height: 34,
        paddingLeft: 13, paddingRight: 10, flexShrink: 0,
        borderBottom: '1px solid #18202e', background: 'rgba(0,0,0,0.12)',
      }}>
        <span style={{ color: '#2e3a50', display: 'flex', flexShrink: 0 }}>{icon}</span>
        <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10.5, fontWeight: 700, color: '#4a566a', flex: 1, letterSpacing: '0.07em', textTransform: 'uppercase' }}>
          {title}
        </span>
        {onAction && actionLabel && (
          <button
            onClick={onAction}
            style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#4a9eff', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 4 }}
            onMouseEnter={e => { e.currentTarget.style.color = '#e8622f'; e.currentTarget.style.background = 'rgba(232,98,47,0.08)' }}
            onMouseLeave={e => { e.currentTarget.style.color = '#4a9eff'; e.currentTarget.style.background = 'none' }}
          >
            {actionLabel} →
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

function StatPill({ icon, value, label, color }: { icon: string; value: number | string; label: string; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, fontWeight: 700, color: '#283047', letterSpacing: '0.09em', textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 20, fontWeight: 700, color, lineHeight: 1, textShadow: `0 0 18px ${color}40` }}>
        {icon}{value}
      </span>
    </div>
  )
}

function SmallBtn({ label, color, disabled, onClick }: {
  label: string; color?: string; disabled: boolean; onClick: () => void
}) {
  const [hover, setHover] = useState(false)
  const c = color ?? '#7b8499'
  const active = !!color
  const borderColor = active ? c : '#1a2030'
  const bgColor = active ? `${c}14` : 'transparent'
  const textColor = active ? c : '#7b8499'

  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => !disabled && setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 24, paddingLeft: 12, paddingRight: 12, borderRadius: 5,
        background: hover && !disabled ? `${c}1b` : bgColor,
        border: `1px solid ${hover && !disabled ? `${borderColor}cc` : borderColor}`,
        color: disabled ? '#2a3348' : textColor,
        fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11.5, fontWeight: 500,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled && !active ? 0.5 : 1,
        boxShadow: active && !disabled ? `0 0 12px ${c}25` : 'none',
        transition: 'border-color 0.12s, background 0.12s',
        whiteSpace: 'nowrap',
      }}
    >{label}</button>
  )
}

// ── SVG Icons ─────────────────────────────────────────────────────────────────

function RefreshIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.1-3.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M12.5 3v3h-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SyncIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M3 8C3 5.2 5.2 3 8 3c1.5 0 2.8.6 3.8 1.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M13 8c0 2.8-2.2 5-5 5-1.5 0-2.8-.6-3.8-1.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M11.5 1.5v3.5H15" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 14.5V11H1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}


function LockCardIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="10.5" r="1" fill="currentColor" />
    </svg>
  )
}

function SuggestionsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 7a2 2 0 1 1 4 0c0 1-.8 1.5-1.5 2v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8.5" cy="12" r="0.8" fill="currentColor" />
    </svg>
  )
}

function PRCardIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <circle cx="4" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 5.5v5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M12 10.5V8a2 2 0 0 0-2-2H7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M6 5.5L4 3.5 2 5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CommitEntry } from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { contributionData } from '@/lib/contributionData'
import { Tooltip } from '@/components/ui/Tooltip'
import {
  computeActivity,
  formatDateForTooltip,
  getContributionColor,
  getContributionLevel,
  calculateStats,
  toDateKey,
  type DayActivity,
} from '@/lib/activityUtils'
import { ActionBtn } from '@/components/ui/ActionBtn'

interface ContributionGraphProps {
  repoPath: string
}

const LEGEND_SIZE = 11
const WEEKDAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun']
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_SHOWN = 2

interface LoadedMonths {
  repoPath: string
  key: string
  months: Record<number, CommitEntry[]>
  identity: { name: string; email: string }
}

const monthIndexOf = (year: number, month: number) => year * 12 + month

export function ContributionGraph({ repoPath }: ContributionGraphProps) {
  const historyTick = useRepoStore(s => s.historyTick)
  const [loaded, setLoaded] = useState<LoadedMonths>({ repoPath: '', key: '', months: {}, identity: { name: '', email: '' } })
  const [view, setView] = useState<'you' | 'team'>('you')
  const nowDate = new Date()
  const thisMonthIndex = monthIndexOf(nowDate.getUTCFullYear(), nowDate.getUTCMonth())
  // The newest of the two displayed months; the other is always the month before it.
  const [endIndex, setEndIndex] = useState(thisMonthIndex)
  const oldestIndex = thisMonthIndex - 60 // computeActivity keeps five years
  const dataKey = `${repoPath}|${historyTick}`
  const loadedRef = useRef(loaded)
  loadedRef.current = loaded

  // Months load lazily and independently. contributionData caches each month and shares
  // in-flight requests, so paging back only reads the one month that is not loaded yet.
  useEffect(() => {
    let mounted = true
    const timer = setTimeout(() => {
      for (let offset = MONTHS_SHOWN - 1; offset >= 0; offset--) {
        const index = endIndex - offset
        const have = loadedRef.current
        if (have.key === dataKey && index in have.months) continue
        contributionData(repoPath, historyTick, Math.floor(index / 12), index % 12)
          .then(({ commits, identity }) => {
            if (!mounted) return
            setLoaded(prev => prev.key === dataKey
              ? { ...prev, months: { ...prev.months, [index]: commits }, identity }
              : { repoPath, key: dataKey, months: { [index]: commits }, identity })
          })
          .catch(err => {
            console.error('[ContributionGraph] Error loading commits:', err)
            if (!mounted) return
            setLoaded(prev => prev.key === dataKey
              ? { ...prev, months: { ...prev.months, [index]: [] } }
              : { repoPath, key: dataKey, months: { [index]: [] }, identity: prev.identity })
          })
      }
    }, 150)
    return () => { mounted = false; clearTimeout(timer) }
  }, [repoPath, historyTick, dataKey, endIndex])

  const shownIndexes = useMemo(
    () => Array.from({ length: MONTHS_SHOWN }, (_, i) => endIndex - (MONTHS_SHOWN - 1 - i)),
    [endIndex],
  )
  // Keep the previous data for this repository visible while a refresh is in flight; never another repository's.
  const monthData = loaded.repoPath === repoPath ? loaded.months : EMPTY_MONTHS
  const identity = loaded.identity

  const visibleCommits = useMemo(() => {
    // A commit on a month boundary is read by both neighbouring months, so de-duplicate.
    const byHash = new Map<string, CommitEntry>()
    for (const index of shownIndexes) for (const commit of monthData[index] ?? []) byHash.set(commit.hash, commit)
    const all = [...byHash.values()]
    if (view === 'team') return all

    const email = identity.email.trim().toLocaleLowerCase()
    const name = identity.name.trim().toLocaleLowerCase()
    return all.filter(commit =>
      (email && commit.email.trim().toLocaleLowerCase() === email) ||
      (name && commit.author.trim().toLocaleLowerCase() === name)
    )
  }, [monthData, shownIndexes, identity, view])

  const activity = useMemo(() => computeActivity(visibleCommits, 1825), [visibleCommits])
  const todayKey = toDateKey(Date.now())

  const rangeActivity = useMemo(() => {
    const prefixes = shownIndexes.map(i => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-`)
    const filtered = new Map<string, DayActivity>()
    for (const [key, val] of activity) if (prefixes.some(p => key.startsWith(p))) filtered.set(key, val)
    return filtered
  }, [activity, shownIndexes])
  const stats = useMemo(() => calculateStats(rangeActivity), [rangeActivity])

  const pageBack      = useCallback(() => setEndIndex(i => Math.max(oldestIndex + MONTHS_SHOWN - 1, i - 1)), [oldestIndex])
  const pageForward   = useCallback(() => setEndIndex(i => Math.min(thisMonthIndex, i + 1)), [thisMonthIndex])
  const goToThisMonth = useCallback(() => setEndIndex(thisMonthIndex), [thisMonthIndex])

  const first = shownIndexes[0]
  const last = shownIndexes[shownIndexes.length - 1]
  const rangeLabel = `${SHORT_MONTHS[first % 12]} – ${SHORT_MONTHS[last % 12]} ${Math.floor(last / 12)}`

  return (
    <Card
      title="Contribution Graph"
      icon={<GraphIcon />}
      actions={
        <>
          <ViewToggle view={view} onChange={setView} />
          <div style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
            <NavButton onClick={pageBack} title="Load earlier months">‹</NavButton>
            <NavButton onClick={goToThisMonth} title="Jump to the current month">{rangeLabel}</NavButton>
            <NavButton onClick={pageForward} title="Later months">›</NavButton>
          </div>
        </>
      }
    >
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, flexShrink: 0 }}>
          <Stat label="Commits" value={stats.totalCommits} />
          <Stat label="Active days" value={stats.totalActiveDays} />
          <Stat label="Max streak" value={`${stats.maxStreak}d`} />
          <Stat label="Current" value={`${stats.currentStreak}d`} />
        </div>

        {/* Both months share the card's remaining height; cells stretch to fill it */}
        <div style={{ display: 'flex', gap: 8, flex: 1, minHeight: 0 }}>
          <div style={{ display: 'grid', gridTemplateRows: '20px repeat(7, minmax(0, 1fr))', rowGap: 3, flexShrink: 0 }}>
            <span />
            {WEEKDAY_LABELS.map((label, i) => (
              <span key={i} style={{ display: 'flex', alignItems: 'center', fontSize: 8, color: '#344057', fontFamily: 'var(--lg-font-ui)' }}>{label}</span>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14, flex: 1, minWidth: 0 }}>
            {shownIndexes.map(index => (
              <MonthGrid
                key={index}
                year={Math.floor(index / 12)}
                month={index % 12}
                activity={activity}
                todayKey={todayKey}
                loading={!(index in monthData)}
              />
            ))}
          </div>
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4, fontSize: 9, color: '#344057', flexShrink: 0 }}>
          <span>{rangeLabel}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>Less</span>
            {[0, 1, 2, 3, 4].map(level => (
              <div
                key={level}
                style={{
                  width: LEGEND_SIZE,
                  height: LEGEND_SIZE,
                  borderRadius: 2,
                  background: getContributionColor(level as 0 | 1 | 2 | 3 | 4, 'dark'),
                }}
              />
            ))}
            <span>More</span>
          </span>
        </div>
      </div>
    </Card>
  )
}

const EMPTY_MONTHS: Record<number, CommitEntry[]> = {}

// ── Sub-components ────────────────────────────────────────────────────────────

function MonthGrid({ year, month, activity, todayKey, loading }: {
  year: number; month: number
  activity: Map<string, DayActivity>
  todayKey: string
  loading: boolean
}) {
  // Monday-first week columns covering the month; the padding cells stay empty.
  const { cells, weeks, commitCount } = useMemo(() => {
    const lead = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7
    const dayCount = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    const list: (DayActivity | null)[] = Array(lead).fill(null)
    let count = 0
    for (let d = 1; d <= dayCount; d++) {
      const key = toDateKey(Date.UTC(year, month, d))
      const day = activity.get(key) ?? { date: key, count: 0, commits: [], authors: new Set<string>(), filesChanged: 0 }
      count += day.count
      list.push(day)
    }
    while (list.length % 7 !== 0) list.push(null)
    return { cells: list, weeks: list.length / 7, commitCount: count }
  }, [activity, year, month])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
      <div style={{ height: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', fontSize: 11, flexShrink: 0 }}>
        <span style={{ fontWeight: 600, color: '#8a94a8', fontFamily: 'var(--lg-font-ui)' }}>{SHORT_MONTHS[month]} {year}</span>
        <span style={{ fontSize: 10, color: '#344057', fontFamily: 'var(--lg-font-ui)' }}>
          {loading ? 'loading…' : `${commitCount.toLocaleString()} commit${commitCount !== 1 ? 's' : ''}`}
        </span>
      </div>
      <div style={{
        display: 'grid', gridAutoFlow: 'column', flex: 1, minHeight: 0,
        gridTemplateRows: 'repeat(7, minmax(0, 1fr))',
        gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))`,
        gap: 3,
      }}>
        {cells.map((day, i) => {
          if (!day) return <div key={i} />
          if (loading) {
            return <div key={i} style={{ borderRadius: 3, background: '#131c30', opacity: 0.7 }} />
          }
          const isFuture = day.date > todayKey
          const color = getContributionColor(getContributionLevel(day.count), 'dark')
          return (
            <Tooltip key={i} content={<ContributionTooltip day={day} />} side="top" delay={150}>
              <div
                style={{
                  borderRadius: 3, background: color, opacity: isFuture ? 0.35 : 1, minWidth: 0, minHeight: 0,
                  outline: day.date === todayKey ? '1.5px solid #4a9eff' : 'none', outlineOffset: 1,
                  cursor: day.count > 0 ? 'pointer' : 'default',
                }}
              />
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}


function ContributionTooltip({ day }: { day: DayActivity }) {
  const level = getContributionLevel(day.count)
  const color = getContributionColor(level, 'dark')

  return (
    <div style={{ maxWidth: 220 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <div style={{ width: 9, height: 9, borderRadius: 2, background: color, flexShrink: 0, border: '1px solid rgba(255,255,255,0.08)' }} />
        <div style={{ fontSize: 11, fontWeight: 600, color: '#c8d0e8' }}>
          {formatDateForTooltip(day.date)}
        </div>
      </div>
      {day.count === 0 ? (
        <div style={{ fontSize: 10, color: '#344057' }}>No activity</div>
      ) : (
        <>
          <div style={{ fontSize: 10, color: '#5a6880', marginBottom: 2 }}>
            {day.count} commit{day.count !== 1 ? 's' : ''}
          </div>
          {day.authors.size > 0 && (
            <div style={{ fontSize: 10, color: '#5a6880', marginBottom: 2 }}>
              {day.authors.size} contributor{day.authors.size !== 1 ? 's' : ''}
            </div>
          )}
          {day.filesChanged > 0 && (
            <div style={{ fontSize: 10, color: '#5a6880', marginBottom: 2 }}>
              ~{day.filesChanged} file{day.filesChanged !== 1 ? 's' : ''} changed
            </div>
          )}
          {day.commits.length > 0 && (
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {day.commits.slice(0, 5).map((commit) => (
                <div key={commit.hash} style={{ fontSize: 9, color: '#8a94a8', fontFamily: 'var(--lg-font-mono)', wordBreak: 'break-word' }}>
                  • {truncate(commit.message, 50)}
                </div>
              ))}
              {day.commits.length > 5 && (
                <div style={{ fontSize: 9, color: '#344057', fontStyle: 'italic' }}>
                  +{day.commits.length - 5} more commit{day.commits.length - 5 !== 1 ? 's' : ''}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '7px 10px', borderRadius: 7, background: '#0d1119', border: '1px solid #1a2030' }}>
      <div style={{ fontSize: 17, fontWeight: 700, color: '#c8d0e8', lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: 9, color: '#4a566a', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
    </div>
  )
}

function NavButton({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title?: string }) {
  return (
    <ActionBtn
      onClick={onClick}
      title={title}
      size="sm"
      style={{ height: 22, paddingLeft: 8, paddingRight: 8, fontSize: 11, fontWeight: 600 }}
    >
      {children}
    </ActionBtn>
  )
}

function ViewToggle({ view, onChange }: { view: 'you' | 'team'; onChange: (view: 'you' | 'team') => void }) {
  return (
    <div role="group" aria-label="Contribution view" style={{ display: 'flex', padding: 2, gap: 2, borderRadius: 6, background: '#0d1119', border: '1px solid #20283a' }}>
      {(['you', 'team'] as const).map(option => {
        const selected = view === option
        return (
          <button
            key={option}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option)}
            style={{
              height: 20,
              padding: '0 8px',
              border: 0,
              borderRadius: 4,
              background: selected ? '#25324a' : 'transparent',
              color: selected ? '#c8d0e8' : '#56647a',
              fontFamily: 'var(--lg-font-ui)',
              fontSize: 9.5,
              fontWeight: 650,
              cursor: 'pointer',
            }}
          >
            {option === 'you' ? 'Your view' : 'Team view'}
          </button>
        )
      })}
    </div>
  )
}

function Card({ title, icon, actions, children }: { title: string; icon: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{
      background: '#131720',
      border: '1px solid #1a2030',
      borderRadius: 10,
      boxShadow: '0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.025)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      height: '100%',
      minHeight: 0,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 34,
        paddingLeft: 13,
        paddingRight: 10,
        flexShrink: 0,
        borderBottom: '1px solid #18202e',
        background: 'rgba(0,0,0,0.12)',
      }}>
        <span style={{ color: '#2e3a50', display: 'flex', flexShrink: 0 }}>{icon}</span>
        <span style={{
          fontFamily: 'var(--lg-font-ui)',
          fontSize: 10.5,
          fontWeight: 700,
          color: '#4a566a',
          flex: 1,
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
        }}>
          {title}
        </span>
        {actions}
      </div>
      {children}
    </div>
  )
}

function GraphIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="3" height="3" rx="0.5" fill="currentColor" />
      <rect x="6" y="2" width="3" height="3" rx="0.5" fill="currentColor" fillOpacity="0.5" />
      <rect x="10" y="2" width="3" height="3" rx="0.5" fill="currentColor" fillOpacity="0.3" />
      <rect x="2" y="6" width="3" height="3" rx="0.5" fill="currentColor" fillOpacity="0.4" />
      <rect x="6" y="6" width="3" height="3" rx="0.5" fill="currentColor" />
      <rect x="10" y="6" width="3" height="3" rx="0.5" fill="currentColor" fillOpacity="0.2" />
      <rect x="2" y="10" width="3" height="3" rx="0.5" fill="currentColor" fillOpacity="0.6" />
      <rect x="6" y="10" width="3" height="3" rx="0.5" fill="currentColor" fillOpacity="0.3" />
      <rect x="10" y="10" width="3" height="3" rx="0.5" fill="currentColor" fillOpacity="0.8" />
    </svg>
  )
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function truncate(str: string, len: number): string {
  if (str.length <= len) return str
  return str.slice(0, len - 3) + '...'
}

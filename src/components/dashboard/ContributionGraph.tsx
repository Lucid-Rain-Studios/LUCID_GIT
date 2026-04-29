import React, { useCallback, useEffect, useState, useMemo } from 'react'
import { ipc, CommitEntry } from '@/ipc'
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

interface ContributionGraphProps {
  repoPath: string
}

const DAY_SIZE = 11
const DAY_GAP = 3
const MONTH_LABEL_HEIGHT = 24
const WEEKDAY_LABEL_WIDTH = 28

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function ContributionGraph({ repoPath }: ContributionGraphProps) {
  const [commits, setCommits] = useState<CommitEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [currentYear, setCurrentYear] = useState(() => new Date().getFullYear())

  // Load commits on mount and when repoPath changes
  useEffect(() => {
    let mounted = true
    setLoading(true)

    ipc.log(repoPath, { all: true, limit: 10000 })
      .then(data => {
        if (mounted) {
          setCommits(data)
        }
      })
      .catch((err) => {
        console.error('[ContributionGraph] Error loading commits:', err)
        if (mounted) setCommits([])
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })

    return () => { mounted = false }
  }, [repoPath])

  // Compute activity data for the last 1825 days
  const activity = useMemo(() => computeActivity(commits, 1825), [commits])

  const goToPreviousYear = useCallback(() => setCurrentYear(y => y - 1), [])
  const goToNextYear     = useCallback(() => setCurrentYear(y => y + 1), [])
  const goToThisYear     = useCallback(() => setCurrentYear(new Date().getFullYear()), [])

  const todayKey = useMemo(() => toDateKey(Date.now()), [])

  const yearActivity = useMemo(() => {
    const prefix = `${currentYear}-`
    const filtered = new Map<string, DayActivity>()
    for (const [key, val] of activity) {
      if (key.startsWith(prefix)) filtered.set(key, val)
    }
    return filtered
  }, [activity, currentYear])

  const stats = useMemo(() => calculateStats(yearActivity), [yearActivity])

  // Calculate visible weeks for year view
  const { yearWeeks, monthLabels, overflowKeys } = useMemo(() => {
    // Grid bounds — all UTC
    const jan1  = new Date(Date.UTC(currentYear, 0, 1))
    const dec31 = new Date(Date.UTC(currentYear, 11, 31))

    // Sunday on or before Jan 1
    const gridStart = new Date(jan1)
    gridStart.setUTCDate(gridStart.getUTCDate() - gridStart.getUTCDay())

    // Saturday on or after Dec 31
    const gridEnd = new Date(dec31)
    gridEnd.setUTCDate(gridEnd.getUTCDate() + (6 - gridEnd.getUTCDay()))

    const jan1Key  = toDateKey(jan1.getTime())
    const dec31Key = toDateKey(dec31.getTime())

    const weeks: DayActivity[][] = []
    const overflow = new Set<string>()
    const cur = new Date(gridStart)

    while (cur <= gridEnd) {
      const week: DayActivity[] = []
      for (let i = 0; i < 7; i++) {
        const key = toDateKey(cur.getTime())
        if (key < jan1Key || key > dec31Key) overflow.add(key)
        week.push(activity.get(key) ?? {
          date: key, count: 0, commits: [], authors: new Set(), filesChanged: 0,
        })
        cur.setUTCDate(cur.getUTCDate() + 1)
      }
      weeks.push(week)
    }

    // Month label: find which week column the 1st of each month falls in
    const labels: Array<{ label: string; weekIdx: number }> = []
    for (let m = 0; m < 12; m++) {
      const firstOfMonth = new Date(Date.UTC(currentYear, m, 1))
      const daysSinceStart = (firstOfMonth.getTime() - gridStart.getTime()) / 86400000
      const weekIdx = Math.floor(daysSinceStart / 7)
      if (weekIdx >= 0 && weekIdx < weeks.length) {
        labels.push({ label: SHORT_MONTHS[m], weekIdx })
      }
    }

    return { yearWeeks: weeks, monthLabels: labels, overflowKeys: overflow }
  }, [activity, currentYear])

  // SVG dimensions
  const svgWidth  = yearWeeks.length * (DAY_SIZE + DAY_GAP) + WEEKDAY_LABEL_WIDTH + 10
  const svgHeight = MONTH_LABEL_HEIGHT + 7 * (DAY_SIZE + DAY_GAP) + 10

  if (loading) {
    return (
      <Card title="Contribution Graph" icon={<GraphIcon />}>
        <div style={{ padding: 20, textAlign: 'center', color: '#344057', fontSize: 12 }}>
          Loading activity data...
        </div>
      </Card>
    )
  }

  return (
    <Card title="Contribution Graph" icon={<GraphIcon />}>
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Header with stats and navigation */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ display: 'flex', gap: 12, fontSize: 10.5, color: '#4a566a' }}>
            <Stat label="Total" value={stats.totalCommits} />
            <Stat label="Active days" value={stats.totalActiveDays} />
            <Stat label="Max streak" value={`${stats.maxStreak}d`} />
            <Stat label="Current" value={`${stats.currentStreak}d`} />
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <NavButton onClick={goToPreviousYear}>‹</NavButton>
            <NavButton onClick={goToThisYear}>{currentYear}</NavButton>
            <NavButton onClick={goToNextYear}>›</NavButton>
          </div>
        </div>

        {/* Graph container */}
        <div style={{ overflowX: 'auto', paddingTop: 4 }}>
          <svg
            width={svgWidth}
            height={svgHeight}
            style={{ display: 'block' }}
          >
            {/* Month labels */}
            <g>
              {monthLabels.map(({ label, weekIdx }) => (
                <text
                  key={label}
                  x={WEEKDAY_LABEL_WIDTH + weekIdx * (DAY_SIZE + DAY_GAP)}
                  y={13}
                  fill="#5a6880"
                  fontSize={9}
                  fontFamily="'IBM Plex Sans', system-ui"
                >
                  {label}
                </text>
              ))}
            </g>

            {/* Day of week labels — Mon / Wed / Fri only (indices 1, 3, 5) */}
            <g>
              {WEEKDAY_LABELS.map((label, idx) => {
                if (idx !== 1 && idx !== 3 && idx !== 5) return null
                return (
                  <text
                    key={label}
                    x={WEEKDAY_LABEL_WIDTH - 4}
                    y={MONTH_LABEL_HEIGHT + (idx * (DAY_SIZE + DAY_GAP)) + DAY_SIZE + 3}
                    fill="#344057"
                    fontSize={8.5}
                    fontFamily="'IBM Plex Sans', system-ui"
                    textAnchor="end"
                    dominantBaseline="middle"
                  >
                    {label}
                  </text>
                )
              })}
            </g>

            {/* Contribution squares */}
            <g transform={`translate(${WEEKDAY_LABEL_WIDTH}, ${MONTH_LABEL_HEIGHT})`}>
              {yearWeeks.map((week, weekIdx) =>
                week.map((day, dayIdx) => {
                  const x = weekIdx * (DAY_SIZE + DAY_GAP)
                  const y = dayIdx * (DAY_SIZE + DAY_GAP)

                  if (overflowKeys.has(day.date)) {
                    return (
                      <rect
                        key={`${day.date}-${weekIdx}-${dayIdx}`}
                        x={x}
                        y={y}
                        width={DAY_SIZE}
                        height={DAY_SIZE}
                        fill="#0e1520"
                        rx={2}
                      />
                    )
                  }

                  const level   = getContributionLevel(day.count)
                  const color   = getContributionColor(level, 'dark')
                  const isToday = day.date === todayKey

                  return (
                    <Tooltip
                      key={`${day.date}-${weekIdx}-${dayIdx}`}
                      content={<ContributionTooltip day={day} />}
                      asSvgGroup
                      side="top"
                      delay={150}
                    >
                      <rect
                        x={x}
                        y={y}
                        width={DAY_SIZE}
                        height={DAY_SIZE}
                        fill={color}
                        rx={2}
                        stroke={isToday ? '#4a9eff' : 'none'}
                        strokeWidth={isToday ? 1 : 0}
                        style={{ cursor: day.count > 0 ? 'pointer' : 'default' }}
                      />
                    </Tooltip>
                  )
                })
              )}
            </g>
          </svg>
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4, fontSize: 9, color: '#344057', marginTop: 4 }}>
          <span>Less</span>
          {[0, 1, 2, 3, 4].map(level => (
            <div
              key={level}
              style={{
                width: DAY_SIZE,
                height: DAY_SIZE,
                borderRadius: 2,
                background: getContributionColor(level as 0 | 1 | 2 | 3 | 4, 'dark'),
              }}
            />
          ))}
          <span>More</span>
        </div>
      </div>
    </Card>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

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
                <div key={commit.hash} style={{ fontSize: 9, color: '#8a94a8', fontFamily: "'JetBrains Mono', monospace", wordBreak: 'break-word' }}>
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
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#c8d0e8', lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: 9, color: '#4a566a', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
    </div>
  )
}

function NavButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 22,
        padding: '0 8px',
        borderRadius: 4,
        background: 'transparent',
        border: '1px solid #1a2030',
        color: '#4a566a',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: "'IBM Plex Sans', system-ui",
        transition: 'all 0.1s',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = '#2f3a54'
        e.currentTarget.style.color = '#c8d0e8'
        e.currentTarget.style.background = 'rgba(255,255,255,0.03)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = '#1a2030'
        e.currentTarget.style.color = '#4a566a'
        e.currentTarget.style.background = 'transparent'
      }}
    >
      {children}
    </button>
  )
}

function Card({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{
      background: '#131720',
      border: '1px solid #1a2030',
      borderRadius: 10,
      boxShadow: '0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.025)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
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
          fontFamily: "'IBM Plex Sans', system-ui",
          fontSize: 10.5,
          fontWeight: 700,
          color: '#4a566a',
          flex: 1,
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
        }}>
          {title}
        </span>
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

import React, { useCallback, useEffect, useState, useMemo } from 'react'
import { ipc, CommitEntry } from '@/ipc'
import { Tooltip } from '@/components/ui/Tooltip'
import {
  computeActivity,
  formatDateForTooltip,
  getContributionColor,
  getContributionLevel,
  calculateStats,
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

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

export function ContributionGraph({ repoPath }: ContributionGraphProps) {
  const [commits, setCommits] = useState<CommitEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() }
  })

  // Load commits on mount and when repoPath changes
  useEffect(() => {
    let mounted = true
    setLoading(true)

    ipc.log(repoPath, { all: true, limit: 5000 })
      .then(data => {
        if (mounted) {
          console.log('[ContributionGraph] Loaded', data.length, 'commits')
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

  // Compute activity data for the last 365 days
  const activity = useMemo(() => {
    const act = computeActivity(commits, 365)
    console.log('[ContributionGraph] Activity map size:', act.size, 'entries')
    // Log some sample data
    const sampleDays = Array.from(act.values()).filter(d => d.count > 0).slice(0, 3)
    sampleDays.forEach(d => {
      console.log('[ContributionGraph] Sample day:', d.date, 'commits:', d.count)
    })
    return act
  }, [commits])

  const stats = useMemo(() => calculateStats(activity), [activity])

  // Navigation handlers
  const goToPreviousMonth = useCallback(() => {
    setCurrentMonth(prev => {
      if (prev.month === 0) {
        return { year: prev.year - 1, month: 11 }
      }
      return { year: prev.year, month: prev.month - 1 }
    })
  }, [])

  const goToNextMonth = useCallback(() => {
    setCurrentMonth(prev => {
      if (prev.month === 11) {
        return { year: prev.year + 1, month: 0 }
      }
      return { year: prev.year, month: prev.month + 1 }
    })
  }, [])

  const goToToday = useCallback(() => {
    const now = new Date()
    setCurrentMonth({ year: now.getFullYear(), month: now.getMonth() })
  }, [])

  // Calculate visible weeks for current month view
  const visibleWeeks = useMemo(() => {
    const currentMonthStart = new Date(currentMonth.year, currentMonth.month, 1)
    const currentMonthEnd = new Date(currentMonth.year, currentMonth.month + 1, 0)

    console.log('[ContributionGraph] Rendering month:', currentMonth.year, currentMonth.month)

    // Find the Sunday before the first of the month
    const startDate = new Date(currentMonthStart)
    const dayOfWeek = startDate.getDay()
    startDate.setDate(startDate.getDate() - dayOfWeek)

    // Find the Saturday after the last of the month
    const endDate = new Date(currentMonthEnd)
    const endDayOfWeek = endDate.getDay()
    endDate.setDate(endDate.getDate() + (6 - endDayOfWeek))

    const result: DayActivity[][] = []
    const currentDate = new Date(startDate)

    while (currentDate <= endDate) {
      const week: DayActivity[] = []
      for (let i = 0; i < 7; i++) {
        const key = toDateKey(currentDate.getTime())
        const dayActivity = activity.get(key)
        if (dayActivity) {
          week.push(dayActivity)
        } else {
          week.push({
            date: key,
            count: 0,
            commits: [],
            authors: new Set(),
            filesChanged: 0,
          })
        }
        currentDate.setDate(currentDate.getDate() + 1)
      }
      result.push(week)
    }

    console.log('[ContributionGraph] Visible weeks:', result.length, 'Total days:', result.length * 7)
    return result
  }, [activity, currentMonth])

  const currentMonthName = useMemo(() => {
    return `${MONTH_NAMES[currentMonth.month]} ${currentMonth.year}`
  }, [currentMonth])

  // SVG dimensions
  const svgWidth = visibleWeeks.length * (DAY_SIZE + DAY_GAP) + WEEKDAY_LABEL_WIDTH + 10
  const svgHeight = MONTH_LABEL_HEIGHT + (7 * (DAY_SIZE + DAY_GAP)) + 10

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
            <NavButton onClick={goToPreviousMonth}>‹</NavButton>
            <NavButton onClick={goToToday}>Today</NavButton>
            <NavButton onClick={goToNextMonth}>›</NavButton>
          </div>
        </div>

        {/* Month label */}
        <div style={{ fontSize: 11, fontWeight: 600, color: '#5a6880', fontFamily: "'IBM Plex Sans', system-ui" }}>
          {currentMonthName}
        </div>

        {/* Graph container */}
        <div style={{ overflowX: 'auto', paddingBottom: 8, background: '#0d1117', borderRadius: 6, padding: 8 }}>
          <svg
            width={svgWidth}
            height={svgHeight}
            style={{ display: 'block' }}
          >
            {/* Month label */}
            <text
              x={WEEKDAY_LABEL_WIDTH}
              y={14}
              fill="#5a6880"
              fontSize={9}
              fontFamily="'IBM Plex Sans', system-ui"
            >
              {MONTH_NAMES[currentMonth.month]}
            </text>

            {/* Day of week labels */}
            <g>
              {WEEKDAY_LABELS.map((label, idx) => (
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
              ))}
            </g>

            {/* Contribution squares */}
            <g transform={`translate(${WEEKDAY_LABEL_WIDTH}, ${MONTH_LABEL_HEIGHT})`}>
              {visibleWeeks.map((week, weekIdx) =>
                week.map((day, dayIdx) => {
                  const level = getContributionLevel(day.count)
                  const color = getContributionColor(level, 'dark')
                  const x = weekIdx * (DAY_SIZE + DAY_GAP)
                  const y = dayIdx * (DAY_SIZE + DAY_GAP)

                  return (
                    <Tooltip
                      key={`${day.date}-${weekIdx}-${dayIdx}`}
                      content={<ContributionTooltip day={day} />}
                      side="top"
                      asSvgGroup
                    >
                      <rect
                        x={x}
                        y={y}
                        width={DAY_SIZE}
                        height={DAY_SIZE}
                        fill={color}
                        rx={2}
                        style={{
                          cursor: day.count > 0 ? 'pointer' : 'default',
                          transition: 'opacity 0.1s',
                        }}
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
  return (
    <div style={{ padding: 4 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#c8d0e8', marginBottom: 6 }}>
        {formatDateForTooltip(day.date)}
      </div>
      <div style={{ fontSize: 10, color: '#5a6880', marginBottom: 2 }}>
        {day.count} commit{day.count !== 1 ? 's' : ''}
      </div>
      {day.authors.size > 0 && (
        <div style={{ fontSize: 10, color: '#5a6880', marginBottom: 2 }}>
          {day.authors.size} contributor{day.authors.size !== 1 ? 's' : ''}
        </div>
      )}
      {day.commits.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 200 }}>
          {day.commits.slice(0, 5).map((commit, idx) => (
            <div key={commit.hash} style={{ fontSize: 9, color: '#8a94a8', fontFamily: "'JetBrains Mono', monospace" }}>
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

function toDateKey(timestamp: number): string {
  const d = new Date(timestamp)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str
  return str.slice(0, len - 3) + '...'
}

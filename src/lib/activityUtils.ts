import { CommitEntry } from '@/ipc'

export interface DayActivity {
  date: string           // YYYY-MM-DD
  count: number
  commits: CommitEntry[]
  authors: Set<string>
  filesChanged: number
}

export type ContributionLevel = 0 | 1 | 2 | 3 | 4

/**
 * Color scale for contribution graph (GitHub-style green gradient)
 */
export const CONTRIBUTION_COLORS: Record<ContributionLevel, string> = {
  0: '#161b22',      // No contributions
  1: '#0e4429',      // Low (1-2 commits)
  2: '#006d32',      // Medium (3-5 commits)
  3: '#26a641',      // High (6-9 commits)
  4: '#39d353',      // Very high (10+ commits)
}

/**
 * Theme-aware colors for contribution graph
 */
export const CONTRIBUTION_COLORS_THEME: Record<string, Record<ContributionLevel, string>> = {
  dark: {
    0: '#161b22',
    1: '#0e4429',
    2: '#006d32',
    3: '#26a641',
    4: '#39d353',
  },
  darker: {
    0: '#0d1117',
    1: '#0a3d24',
    2: '#005a2a',
    3: '#1f8a36',
    4: '#2fb84a',
  },
  light: {
    0: '#ebedf0',
    1: '#9be9a8',
    2: '#40c463',
    3: '#30a14e',
    4: '#216e39',
  },
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Convert timestamp to YYYY-MM-DD string (UTC)
 */
export function toDateKey(timestamp: number): string {
  const d = new Date(timestamp)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Parse YYYY-MM-DD string to Date
 */
export function fromDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

/**
 * Get the contribution level based on commit count
 */
export function getContributionLevel(count: number): ContributionLevel {
  if (count === 0) return 0
  if (count <= 2) return 1
  if (count <= 5) return 2
  if (count <= 9) return 3
  return 4
}

/**
 * Compute activity data from commits over the last N days
 */
export function computeActivity(commits: CommitEntry[], days: number = 730): Map<string, DayActivity> {
  const activity = new Map<string, DayActivity>()
  const now = Date.now()
  const cutoff = now - (days * MS_PER_DAY)

  // Initialize all days in range with empty activity
  for (let i = 0; i < days; i++) {
    const date = new Date(now - (i * MS_PER_DAY))
    const key = toDateKey(date.getTime())
    activity.set(key, {
      date: key,
      count: 0,
      commits: [],
      authors: new Set(),
      filesChanged: 0,
    })
  }

  // Process commits
  for (const commit of commits) {
    if (commit.timestamp < cutoff) continue

    const key = toDateKey(commit.timestamp)
    const day = activity.get(key)
    if (day) {
      day.count++
      day.commits.push(commit)
      day.authors.add(commit.author)
      // We don't have file count info in basic log, estimate 1 per commit
      day.filesChanged++
    }
  }

  return activity
}

/**
 * Generate week columns for the contribution graph
 * Returns array of weeks, where each week is an array of 7 days (Sun-Sat)
 */
export function generateWeeks(activity: Map<string, DayActivity>, days: number = 365): DayActivity[][] {
  const weeks: DayActivity[][] = []
  const now = new Date()

  // Find the most recent Sunday (start of first week)
  const startDate = new Date(now)
  startDate.setDate(startDate.getDate() - days + 1)
  const dayOfWeek = startDate.getDay()
  startDate.setDate(startDate.getDate() - dayOfWeek) // Go back to Sunday

  const currentDate = new Date(startDate)

  while (currentDate <= now) {
    const week: DayActivity[] = []
    for (let i = 0; i < 7; i++) {
      const key = toDateKey(currentDate.getTime())
      week.push(activity.get(key) || {
        date: key,
        count: 0,
        commits: [],
        authors: new Set(),
        filesChanged: 0,
      })
      currentDate.setDate(currentDate.getDate() + 1)
    }
    weeks.push(week)
  }

  return weeks
}

/**
 * Get month labels for the contribution graph
 * Returns array of { month: string, offset: number } where offset is the week column
 */
export function getMonthLabels(weeks: DayActivity[][]): { month: string; offset: number }[] {
  const labels: { month: string; offset: number }[] = []
  let lastMonth = -1

  const now = new Date()
  const startDate = new Date(now)
  startDate.setDate(startDate.getDate() - (weeks.length * 7) + 1)

  for (let weekIdx = 0; weekIdx < weeks.length; weekIdx++) {
    const week = weeks[weekIdx]
    if (week.length === 0) continue

    const firstDay = week[0]
    const date = fromDateKey(firstDay.date)
    const month = date.getUTCMonth()

    if (month !== lastMonth) {
      labels.push({
        month: date.toLocaleString('en-US', { month: 'short' }),
        offset: weekIdx,
      })
      lastMonth = month
    }
  }

  return labels
}

/**
 * Format a date for display in tooltip
 */
export function formatDateForTooltip(dateKey: string): string {
  const date = fromDateKey(dateKey)
  return date.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

/**
 * Get color for a contribution level based on theme
 */
export function getContributionColor(level: ContributionLevel, theme: string = 'dark'): string {
  const themeColors = CONTRIBUTION_COLORS_THEME[theme] || CONTRIBUTION_COLORS_THEME.dark
  return themeColors[level] || CONTRIBUTION_COLORS[level] || CONTRIBUTION_COLORS[0]
}

/**
 * Calculate statistics for the contribution graph
 */
export function calculateStats(activity: Map<string, DayActivity>): {
  totalCommits: number
  totalActiveDays: number
  maxStreak: number
  currentStreak: number
  busiestDay: DayActivity | null
} {
  let totalCommits = 0
  let totalActiveDays = 0
  let maxStreak = 0
  let currentStreak = 0
  let busiestDay: DayActivity | null = null
  let maxCount = 0

  const sortedDays = Array.from(activity.values()).sort((a, b) =>
    fromDateKey(b.date).getTime() - fromDateKey(a.date).getTime()
  )

  // Calculate totals and find busiest day
  for (const day of sortedDays) {
    totalCommits += day.count
    if (day.count > 0) {
      totalActiveDays++
      if (day.count > maxCount) {
        maxCount = day.count
        busiestDay = day
      }
    }
  }

  // Calculate streaks
  const today = toDateKey(Date.now())
  let checkingStreak = true
  let streakBroken = false

  for (let i = 0; i < sortedDays.length; i++) {
    const day = sortedDays[i]

    if (checkingStreak) {
      if (day.count > 0) {
        currentStreak++
      } else if (day.date === today || i === 0) {
        // Today or yesterday from today - streak continues if today has no commits yet
        continue
      } else {
        checkingStreak = false
        streakBroken = true
      }
    }

    if (day.count > 0) {
      maxStreak++
    } else if (maxStreak > 0) {
      // Streak broken, don't reset to allow for gaps
    }
  }

  // Recalculate max streak properly
  maxStreak = 0
  let tempStreak = 0
  for (const day of sortedDays) {
    if (day.count > 0) {
      tempStreak++
      maxStreak = Math.max(maxStreak, tempStreak)
    } else {
      tempStreak = 0
    }
  }

  // Recalculate current streak from today backwards
  currentStreak = 0
  const todayKey = toDateKey(Date.now())
  const todayActivity = activity.get(todayKey)

  if (todayActivity && todayActivity.count > 0) {
    // Count from today
    for (const day of sortedDays) {
      if (day.count > 0) {
        currentStreak++
      } else {
        break
      }
    }
  } else if (todayActivity) {
    // Today has no commits yet, check from yesterday
    const yesterdayKey = toDateKey(Date.now() - MS_PER_DAY)
    const yesterdayActivity = activity.get(yesterdayKey)
    if (yesterdayActivity && yesterdayActivity.count > 0) {
      currentStreak = 1
      for (let i = 1; i < sortedDays.length; i++) {
        const day = sortedDays[i]
        if (day.date === yesterdayKey) continue
        if (day.count > 0) {
          currentStreak++
        } else {
          break
        }
      }
    }
  }

  return { totalCommits, totalActiveDays, maxStreak, currentStreak, busiestDay }
}

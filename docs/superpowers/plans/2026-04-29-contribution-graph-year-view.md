# Contribution Graph Year View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the month-at-a-time contribution graph with a full calendar-year view (Jan–Dec) with year navigation and inline month labels.

**Architecture:** All changes live in `src/components/dashboard/ContributionGraph.tsx`. State changes from `currentMonth: { year, month }` to `currentYear: number`. The `visibleWeeks` useMemo is replaced by a `yearWeeks` / `monthLabels` / `overflowKeys` triple computed together. Stats are scoped to the displayed year via a `yearActivity` map. The `computeActivity` data window widens from 730 to 1825 days.

**Tech Stack:** React 18, TypeScript, SVG, `@/lib/activityUtils` (existing utilities)

---

## File Map

| File | Change |
|------|--------|
| `src/components/dashboard/ContributionGraph.tsx` | Full rewrite of state, grid algorithm, SVG rendering, nav UI |

`src/lib/activityUtils.ts` is **not** modified — the only change is the explicit argument at the call site inside `ContributionGraph.tsx`.

---

## Task 1: Rewrite ContributionGraph for year view

**Files:**
- Modify: `src/components/dashboard/ContributionGraph.tsx`

All steps modify the same file. Read it once at the start so you know the current line numbers.

---

- [ ] **Step 1: Replace module-level constants**

Find the block at the top of the file containing `WEEKDAY_LABELS` and `MONTH_NAMES`. Replace it with:

```tsx
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
```

`MONTH_NAMES` (full names array) is deleted — it is no longer used anywhere after this task.

---

- [ ] **Step 2: Replace state declaration and navigation handlers**

Find and replace the `useState` for `currentMonth` and the three `useCallback` handlers. Replace the entire block (from the `currentMonth` state down through `goToToday`) with:

```tsx
const [currentYear, setCurrentYear] = useState(() => new Date().getFullYear())

const goToPreviousYear = useCallback(() => setCurrentYear(y => y - 1), [])
const goToNextYear     = useCallback(() => setCurrentYear(y => y + 1), [])
const goToThisYear     = useCallback(() => setCurrentYear(new Date().getFullYear()), [])

const todayKey = useMemo(() => toDateKey(Date.now()), [])
```

---

- [ ] **Step 3: Widen the data window and add year-scoped activity**

Find the `activity` useMemo:
```tsx
const activity = useMemo(() => {
  return computeActivity(commits, 730)
}, [commits])
```

Replace it with:
```tsx
const activity = useMemo(() => computeActivity(commits, 1825), [commits])

const yearActivity = useMemo(() => {
  const prefix = `${currentYear}-`
  const filtered = new Map<string, DayActivity>()
  for (const [key, val] of activity) {
    if (key.startsWith(prefix)) filtered.set(key, val)
  }
  return filtered
}, [activity, currentYear])
```

Then find:
```tsx
const stats = useMemo(() => calculateStats(activity), [activity])
```

Replace with:
```tsx
const stats = useMemo(() => calculateStats(yearActivity), [yearActivity])
```

---

- [ ] **Step 4: Delete the `currentMonthName` useMemo**

Find and delete this block entirely:
```tsx
const currentMonthName = useMemo(() => {
  return `${MONTH_NAMES[currentMonth.month]} ${currentMonth.year}`
}, [currentMonth])
```

---

- [ ] **Step 5: Replace `visibleWeeks` with the year grid useMemo**

Find and replace the entire `visibleWeeks` useMemo with:

```tsx
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
```

---

- [ ] **Step 6: Update SVG dimension calculation**

Find:
```tsx
const svgWidth = visibleWeeks.length * (DAY_SIZE + DAY_GAP) + WEEKDAY_LABEL_WIDTH + 10
const svgHeight = MONTH_LABEL_HEIGHT + (7 * (DAY_SIZE + DAY_GAP)) + 10
```

Replace with:
```tsx
const svgWidth  = yearWeeks.length * (DAY_SIZE + DAY_GAP) + WEEKDAY_LABEL_WIDTH + 10
const svgHeight = MONTH_LABEL_HEIGHT + 7 * (DAY_SIZE + DAY_GAP) + 10
```

---

- [ ] **Step 7: Update the nav buttons JSX**

Find the nav buttons block inside the return:
```tsx
<div style={{ display: 'flex', gap: 4 }}>
  <NavButton onClick={goToPreviousMonth}>‹</NavButton>
  <NavButton onClick={goToToday}>Today</NavButton>
  <NavButton onClick={goToNextMonth}>›</NavButton>
</div>
```

Replace with:
```tsx
<div style={{ display: 'flex', gap: 4 }}>
  <NavButton onClick={goToPreviousYear}>‹</NavButton>
  <NavButton onClick={goToThisYear}>{currentYear}</NavButton>
  <NavButton onClick={goToNextYear}>›</NavButton>
</div>
```

---

- [ ] **Step 8: Remove the month label div**

Find and delete:
```tsx
{/* Month label */}
<div style={{ fontSize: 11, fontWeight: 600, color: '#5a6880', fontFamily: "'IBM Plex Sans', system-ui" }}>
  {currentMonthName}
</div>
```

---

- [ ] **Step 9: Replace the SVG content**

Find the SVG element and replace everything inside it with:

```tsx
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
```

---

- [ ] **Step 10: Type-check**

```bash
npx tsc --noEmit
```

Expected: Zero errors. Common issues to check:
- `currentMonth` referenced anywhere → must be gone
- `visibleWeeks` referenced anywhere → must be gone
- `currentMonthName` referenced anywhere → must be gone
- `MONTH_NAMES` referenced anywhere → must be gone
- `goToPreviousMonth` / `goToNextMonth` / `goToToday` referenced anywhere → must be gone

---

- [ ] **Step 11: Commit**

```bash
git add src/components/dashboard/ContributionGraph.tsx
git commit -m "feat: contribution graph year view with month labels and year navigation"
```

---

## Task 2: Build and visual verification

**Files:** None modified — verification only.

- [ ] **Step 1: Full build**

```bash
npm run build
```

Expected: Completes with no TypeScript or bundler errors. Chunk size warnings are acceptable.

- [ ] **Step 2: Start dev server and visually verify**

```bash
npm run dev
```

Open the app, navigate to the Dashboard. Verify:

1. **Year grid renders** — 52-54 week columns spanning Jan–Dec, 7 rows of day squares.
2. **Month labels** — `Jan`, `Feb`, ..., `Dec` appear above the correct week column for the 1st of each month.
3. **Weekday labels** — Mon, Wed, Fri on the left spine only.
4. **Overflow cells** — The few squares outside Jan 1–Dec 31 (at the grid edges) render as very dark `#0e1520` squares with no tooltip or cursor change.
5. **Today highlight** — Today's square has a blue `#4a9eff` 1px stroke ring when viewing the current year. No ring on other years.
6. **Navigation** — `‹` goes to prior year, `›` goes to next year, the center button shows the displayed year number and clicking it returns to the current year.
7. **Stats** — Total / Active days / Max streak / Current streak reflect the displayed year only (not all-time).
8. **Hover tooltips** — Still work correctly on non-overflow squares.
9. **Legend** — Less → More color scale still shows at the bottom right.
10. **No console errors** of any kind.

- [ ] **Step 3: Commit any final tweaks**

If any visual adjustments were made during verification:

```bash
git add src/components/dashboard/ContributionGraph.tsx
git commit -m "fix: contribution graph year view visual tweaks"
```

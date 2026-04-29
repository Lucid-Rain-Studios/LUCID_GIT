# Contribution Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the contribution graph heatmap — fix the broken Tooltip integration, timezone bug, duplicate code, styling, and UX polish so the component is production-ready.

**Architecture:** Extend the shared `Tooltip` to accept `ReactNode` content and a `asSvgGroup` SVG-safe mode; widen the activity data window to 730 days; fix the UTC-keyed activity map vs. local-time grid mismatch; remove the nested dark box and polish the tooltip content.

**Tech Stack:** React 18, TypeScript, SVG, ReactDOM portals, `ipc.log` for commit data

---

## File Map

| File | Change |
|------|--------|
| `src/components/ui/Tooltip.tsx` | Widen `content` to `ReactNode`; add `asSvgGroup` SVG wrapper mode |
| `src/lib/activityUtils.ts` | Widen data window default to 730 days |
| `src/components/dashboard/ContributionGraph.tsx` | Fix timezone bug, fix Tooltip usage, remove duplicate `toDateKey`, increase log limit, fix styling, polish `ContributionTooltip` |

---

## Task 1: Extend Tooltip component

**Files:**
- Modify: `src/components/ui/Tooltip.tsx`

- [ ] **Step 1: Replace the entire file with the extended implementation**

Open `src/components/ui/Tooltip.tsx` and replace with:

```tsx
import React, { useState, useRef, useCallback } from 'react'
import ReactDOM from 'react-dom'

interface TooltipProps {
  content: React.ReactNode
  children: React.ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  delay?: number
  asSvgGroup?: boolean
}

export function Tooltip({ content, children, side = 'top', delay = 500, asSvgGroup = false }: TooltipProps) {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const wrapRef = useRef<SVGGElement | HTMLSpanElement>(null)

  const show = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (wrapRef.current) setRect((wrapRef.current as Element).getBoundingClientRect())
    }, delay)
  }, [delay])

  const hide = useCallback(() => {
    clearTimeout(timer.current)
    setRect(null)
  }, [])

  const tipStyle: React.CSSProperties = rect ? {
    position: 'fixed',
    zIndex: 9999,
    background: '#1a2030',
    border: '1px solid #2f3a54',
    borderRadius: 5,
    padding: '4px 9px',
    fontSize: 11,
    lineHeight: 1.4,
    color: '#c4cad8',
    fontFamily: "'IBM Plex Sans', system-ui",
    whiteSpace: typeof content === 'string' ? 'nowrap' : 'normal',
    pointerEvents: 'none',
    boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
    ...(side === 'top'    ? { left: rect.left + rect.width / 2, bottom: window.innerHeight - rect.top + 6, transform: 'translateX(-50%)' } :
        side === 'bottom' ? { left: rect.left + rect.width / 2, top: rect.bottom + 6,                      transform: 'translateX(-50%)' } :
        side === 'right'  ? { left: rect.right + 8,             top: rect.top + rect.height / 2,           transform: 'translateY(-50%)' } :
                            { right: window.innerWidth - rect.left + 8, top: rect.top + rect.height / 2,   transform: 'translateY(-50%)' }),
  } : {}

  const portal = rect ? ReactDOM.createPortal(
    <div style={tipStyle}>{content}</div>,
    document.body,
  ) : null

  if (asSvgGroup) {
    return (
      <g ref={wrapRef as React.Ref<SVGGElement>} onMouseEnter={show} onMouseLeave={hide}>
        {children}
        {portal}
      </g>
    )
  }

  return (
    <span ref={wrapRef as React.Ref<HTMLSpanElement>} onMouseEnter={show} onMouseLeave={hide} style={{ display: 'contents' }}>
      {children}
      {portal}
    </span>
  )
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: No errors in `Tooltip.tsx`. Any existing callers passing `content="string"` still compile — the type widened from `string` to `ReactNode`, which is backward-compatible.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/Tooltip.tsx
git commit -m "feat: extend Tooltip to accept ReactNode content and asSvgGroup SVG mode"
```

---

## Task 2: Widen activity data window

**Files:**
- Modify: `src/lib/activityUtils.ts`

- [ ] **Step 1: Change the default data window from 365 to 730 days**

In `src/lib/activityUtils.ts`, find the `computeActivity` function signature (line 86) and change `365` to `730`:

```ts
export function computeActivity(commits: CommitEntry[], days: number = 730): Map<string, DayActivity> {
  const activity = new Map<string, DayActivity>()
  const now = Date.now()
  const cutoff = now - (days * MS_PER_DAY)
```

That's the only change in this file.

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/activityUtils.ts
git commit -m "feat: widen contribution activity window to 730 days"
```

---

## Task 3: Fix ContributionGraph bugs

**Files:**
- Modify: `src/components/dashboard/ContributionGraph.tsx`

This task covers three bugs in one commit: duplicate `toDateKey`, timezone mismatch in `visibleWeeks`, broken Tooltip usage, and the log limit.

- [ ] **Step 1: Remove the local `toDateKey` function and add the import**

At the top of `src/components/dashboard/ContributionGraph.tsx`, find the existing import from `@/lib/activityUtils`:

```ts
import {
  computeActivity,
  formatDateForTooltip,
  getContributionColor,
  getContributionLevel,
  calculateStats,
  type DayActivity,
} from '@/lib/activityUtils'
```

Replace it with (adds `toDateKey`):

```ts
import {
  computeActivity,
  formatDateForTooltip,
  getContributionColor,
  getContributionLevel,
  calculateStats,
  toDateKey,
  type DayActivity,
} from '@/lib/activityUtils'
```

Then delete the local `toDateKey` function near the bottom of the file (lines 417–423):

```ts
// DELETE this entire function:
function toDateKey(timestamp: number): string {
  const d = new Date(timestamp)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
```

- [ ] **Step 2: Increase the log limit to 10 000**

Find the `ipc.log` call in the `useEffect` (around line 42):

```ts
ipc.log(repoPath, { all: true, limit: 5000 })
```

Change to:

```ts
ipc.log(repoPath, { all: true, limit: 10000 })
```

- [ ] **Step 3: Update the `computeActivity` call to pass 730 explicitly**

Find (around line 62):

```ts
const act = computeActivity(commits, 365)
```

Change to:

```ts
const act = computeActivity(commits, 730)
```

- [ ] **Step 4: Fix the timezone bug in `visibleWeeks`**

Find the `visibleWeeks` useMemo (lines 99–141). Replace the entire block with:

```ts
const visibleWeeks = useMemo(() => {
  // Use Date.UTC so grid keys always match the UTC-keyed activity map
  const currentMonthStart = new Date(Date.UTC(currentMonth.year, currentMonth.month, 1))
  const currentMonthEnd   = new Date(Date.UTC(currentMonth.year, currentMonth.month + 1, 0))

  // Find the Sunday on or before the first of the month (UTC)
  const startDate = new Date(currentMonthStart)
  startDate.setUTCDate(startDate.getUTCDate() - startDate.getUTCDay())

  // Find the Saturday on or after the last of the month (UTC)
  const endDate = new Date(currentMonthEnd)
  endDate.setUTCDate(endDate.getUTCDate() + (6 - endDate.getUTCDay()))

  const result: DayActivity[][] = []
  const currentDate = new Date(startDate)

  while (currentDate <= endDate) {
    const week: DayActivity[] = []
    for (let i = 0; i < 7; i++) {
      const key = toDateKey(currentDate.getTime())
      week.push(activity.get(key) ?? {
        date: key,
        count: 0,
        commits: [],
        authors: new Set(),
        filesChanged: 0,
      })
      currentDate.setUTCDate(currentDate.getUTCDate() + 1)
    }
    result.push(week)
  }

  return result
}, [activity, currentMonth])
```

- [ ] **Step 5: Fix the broken Tooltip usage**

Find the Tooltip usage inside the SVG (lines 230–253). It currently uses non-existent `trigger` prop. Replace:

```tsx
return (
  <Tooltip
    key={`${day.date}-${weekIdx}-${dayIdx}`}
    trigger={
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
        onMouseEnter={() => console.log('[ContributionGraph] Hover day:', day.date, 'commits:', day.count)}
        onMouseLeave={() => {}}
      />
    }
  >
    <ContributionTooltip day={day} />
  </Tooltip>
)
```

With:

```tsx
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
      style={{ cursor: day.count > 0 ? 'pointer' : 'default' }}
    />
  </Tooltip>
)
```

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit
```

Expected: No errors. TypeScript confirms `toDateKey` is imported (not local), `Tooltip` receives `content` + `asSvgGroup` (both now valid props).

- [ ] **Step 7: Commit**

```bash
git add src/components/dashboard/ContributionGraph.tsx
git commit -m "fix: contribution graph timezone bug, tooltip API, dedup toDateKey, widen log limit"
```

---

## Task 4: Fix styling and polish ContributionTooltip

**Files:**
- Modify: `src/components/dashboard/ContributionGraph.tsx`

- [ ] **Step 1: Remove the nested dark background box**

Find the graph container div (around line 185):

```tsx
<div style={{ overflowX: 'auto', paddingBottom: 8, background: '#0d1117', borderRadius: 6, padding: 8 }}>
```

Replace with:

```tsx
<div style={{ overflowX: 'auto', paddingTop: 4 }}>
```

- [ ] **Step 2: Show only Mon / Wed / Fri weekday labels**

Find the weekday label `<g>` block (renders all 7 labels). Replace:

```tsx
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
```

With:

```tsx
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
```

- [ ] **Step 3: Polish `ContributionTooltip`**

Find the `ContributionTooltip` function (lines 281–311). Replace the entire function with:

```tsx
function ContributionTooltip({ day }: { day: DayActivity }) {
  const level = getContributionLevel(day.count)
  const color = getContributionColor(level, 'dark')

  return (
    <div style={{ padding: '2px 4px', maxWidth: 220 }}>
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
```

- [ ] **Step 4: Remove leftover console.log statements**

Search the file for `console.log('[ContributionGraph]` and delete all those lines. There are ~5 of them in `useEffect`, the `computeActivity` call block, and the `visibleWeeks` block.

- [ ] **Step 5: Type-check**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboard/ContributionGraph.tsx
git commit -m "feat: polish contribution graph — remove dark box, sparse weekday labels, rich tooltip"
```

---

## Task 5: Build and visual verification

**Files:** None modified — verification only.

- [ ] **Step 1: Full build**

```bash
npm run build
```

Expected: Build completes with no TypeScript or bundler errors.

- [ ] **Step 2: Start dev server and visually verify**

```bash
npm run dev
```

Open the app, navigate to the Dashboard. Verify:

1. **Graph renders** — calendar grid of squares appears to the right of Suggestions, filling the `1.5fr` column.
2. **Colors** — empty days show as dark `#161b22` squares on the card background with no inner dark box around the SVG.
3. **Weekday labels** — only Mon, Wed, Fri appear on the left spine.
4. **Navigation** — clicking `‹` and `›` cycles months; clicking `Today` returns to the current month. Past months within ~2 years show real commit data; future months show an empty grid.
5. **Hover tooltip** — mousing over any square shows the portal-rendered tooltip with date, commit count, contributor count, files changed, and commit message previews. Zero-activity squares show "No activity".
6. **Stats bar** — Total / Active days / Max streak / Current streak update correctly for the loaded 730-day window.
7. **No console errors** about invalid SVG, unknown Tooltip props, or timezone mismatches.

- [ ] **Step 3: Final commit (if any last tweaks were made)**

```bash
git add -p
git commit -m "fix: contribution graph visual verification tweaks"
```

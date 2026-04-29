# Contribution Graph — Design Spec
**Date:** 2026-04-29  
**Status:** Approved

---

## Overview

Complete and polish the `ContributionGraph` component: a calendar-style heatmap on the Dashboard showing repository commit activity. Each cell is one day; color intensity maps to commit volume. Users can cycle through months. Hovering a cell shows a rich tooltip with per-day metrics.

The component already exists as a partial implementation. This spec covers the fixes and completions required to make it production-ready.

---

## Section 1 — Tooltip Component Extension

**File:** `src/components/ui/Tooltip.tsx`

### Changes
- `content` prop type widens from `string` to `React.ReactNode` — fully backward-compatible; all existing string callers continue to work unchanged.
- New optional boolean prop `asSvgGroup?: boolean` (default `false`). When `true`, the wrapper renders as a `<g>` element (valid SVG) instead of an HTML `<span>`, and mouse handlers are forwarded to the child via `React.cloneElement`. This lets contribution squares remain inside the SVG namespace.
- The portal-rendered tooltip div already supports arbitrary children; no change needed there beyond the ReactNode type widening.

### Constraint
No changes to the existing `content`, `side`, or `delay` props beyond the type widening. Zero breaking changes to existing callers.

---

## Section 2 — Data Layer (`src/lib/activityUtils.ts`)

### Changes
- `computeActivity` default window: `365` → `730` days. The call site in `ContributionGraph` passes `730` explicitly. This ensures navigating back ~1 year does not silently zero-out all cells.
- Remove the duplicate `toDateKey` from `ContributionGraph.tsx` and import it from `activityUtils` instead. The implementations are identical; the consolidation eliminates drift risk.
- No other changes to `activityUtils`.

---

## Section 3 — ContributionGraph Component (`src/components/dashboard/ContributionGraph.tsx`)

### Bug fixes

**Timezone bug:** `visibleWeeks` currently computes the calendar grid with local-time `new Date(year, month, day)` but looks up keys stored in UTC format. Fix: use `Date.UTC(year, month, day)` as the baseline so grid keys always match the UTC-keyed activity map regardless of the user's timezone offset.

**Broken Tooltip usage:** Current code passes `trigger` and children props that don't exist on the Tooltip. Fix: replace with the extended API — `<Tooltip content={<ContributionTooltip day={day} />} asSvgGroup side="top">` wrapping the `<rect>`.

**Duplicate code:** Remove local `toDateKey` function; import from `activityUtils`. Keep the local `Card` component (not exported from DashboardPanel) but align its style tokens exactly to DashboardPanel's `Card`.

### Styling fixes

**Remove inner dark box:** Delete the `background: '#0d1117'` wrapper div around the SVG. The SVG renders directly on the card's `#131720` body. Empty cells (`level 0`) use `#161b22` which creates a subtle texture consistent with GitHub's grid look.

**Sizing:** The graph container gets `width: '100%'` so the SVG never clips horizontally within its `1.5fr` column. The `svgWidth` calculation already adapts to `visibleWeeks.length`; no fixed pixel widths imposed.

### UX polish

**Weekday labels:** Show only Mon / Wed / Fri labels (indices 1, 3, 5) to reduce vertical label noise — matches GitHub's sparse-label convention.

**Data call:** Change `ipc.log(repoPath, { all: true, limit: 5000 })` to `limit: 10000` to cover 730 days more reliably on active repos.

**Empty-month handling:** Months in the future or far beyond the data window display an all-empty grid with no error state — expected behavior since those dates have zero activity.

---

## Section 4 — Tooltip Content (`ContributionTooltip`)

Located at the bottom of `ContributionGraph.tsx`.

### Changes
- **Zero-activity state:** When `day.count === 0`, render: date label + "No activity" line in muted color. No empty card.
- **Color indicator:** A small colored square (matching the day's contribution level color) sits inline next to the date label — gives instant visual feedback on which level is being inspected.
- **Files changed:** Show `{day.filesChanged} file{s} changed` row when `filesChanged > 0`.
- **Max width:** Tooltip content div gets `maxWidth: 220px`, `whiteSpace: 'normal'` so long commit messages word-wrap instead of stretching the popup.
- **Commit list cap:** Keep existing 5-commit cap with "+N more" overflow label.

---

## Non-goals

- No light-mode color variant (app is dark-only for now).
- No click-to-drill-down on a day (hover only).
- No PR/merge data sourced separately — commit count is the sole activity metric (files-changed is estimated at 1 per commit since `git log` doesn't return diff stats).
- No animation on month transition.

---

## Files changed

| File | Change type |
|------|-------------|
| `src/components/ui/Tooltip.tsx` | Extend props; add `asSvgGroup` mode |
| `src/lib/activityUtils.ts` | Widen data window to 730 days |
| `src/components/dashboard/ContributionGraph.tsx` | Fix bugs, fix styling, polish UX |

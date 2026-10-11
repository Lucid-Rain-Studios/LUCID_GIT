# Contribution calendar

[Back to index](index.md)

## Source files

- [LucidGit_ClaudeCode_Spec.md](../../LucidGit_ClaudeCode_Spec.md)
- [docs/superpowers/plans/2026-04-29-contribution-graph-year-view.md](../../docs/superpowers/plans/2026-04-29-contribution-graph-year-view.md)
- [docs/superpowers/plans/2026-04-29-contribution-graph.md](../../docs/superpowers/plans/2026-04-29-contribution-graph.md)
- [docs/superpowers/specs/2026-04-29-contribution-graph-design.md](../../docs/superpowers/specs/2026-04-29-contribution-graph-design.md)
- [docs/superpowers/specs/2026-04-29-contribution-graph-year-view-design.md](../../docs/superpowers/specs/2026-04-29-contribution-graph-year-view-design.md)
- [src/components/dashboard/ContributionGraph.tsx](../../src/components/dashboard/ContributionGraph.tsx)
- [src/components/ui/Tooltip.tsx](../../src/components/ui/Tooltip.tsx)
- [src/lib/activityUtils.ts](../../src/lib/activityUtils.ts)
- [src/lib/contributionData.ts](../../src/lib/contributionData.ts)

## Entities and evidence

- **ContributionGraph.tsx** — `src/components/dashboard/ContributionGraph.tsx:L1` · `src_components_dashboard_contributiongraph_tsx`
- **activityUtils.ts** — `src/lib/activityUtils.ts:L1` · `src_lib_activityutils_ts`
- **Tooltip.tsx** — `src/components/ui/Tooltip.tsx:L1` · `src_components_ui_tooltip_tsx`
- **Specified computeActivity UTC-keyed day map with 730-day monthly window** — `docs/superpowers/specs/2026-04-29-contribution-graph-design.md:L29-L34` · `productdocs_activity_map`
- **Requirement: Dashboard commit calendar; day color represents volume** — `docs/superpowers/specs/2026-04-29-contribution-graph-design.md:L7-L9` · `productdocs_contribution_heatmap`
- **Requirement: full Jan-Dec calendar, year navigation and year-scoped stats** — `docs/superpowers/specs/2026-04-29-contribution-graph-year-view-design.md:L7-L9` · `productdocs_year_view`
- **Year-view implementation plan with single-component change scope** — `docs/superpowers/plans/2026-04-29-contribution-graph-year-view.md:L1-L19` · `productdocs_year_plan`
- **Approved monthly contribution-graph design requirements, not implementation proof** — `docs/superpowers/specs/2026-04-29-contribution-graph-design.md:L1-L11` · `productdocs_month_design`
- **Requirement: Date.UTC grid keys match UTC activity map in all timezones** — `docs/superpowers/specs/2026-04-29-contribution-graph-design.md:L40-L46` · `productdocs_utc_grid`
- **Requirement: ReactNode content and SVG g wrapper without breaking Tooltip callers** — `docs/superpowers/specs/2026-04-29-contribution-graph-design.md:L15-L25` · `productdocs_svg_tooltip`
- **Requirement: UTC Sunday-before-Jan1 through Saturday-after-Dec31 week grid** — `docs/superpowers/specs/2026-04-29-contribution-graph-year-view-design.md:L35-L46` · `productdocs_year_grid`
- **Requirement: consolidate toDateKey to prevent duplicate drift** — `docs/superpowers/specs/2026-04-29-contribution-graph-design.md:L32-L34` · `productdocs_date_key_shared`
- **Requirement: date, level color, no activity, files changed and capped messages** — `docs/superpowers/specs/2026-04-29-contribution-graph-design.md:L64-L73` · `productdocs_tooltip_metrics`
- **Requirement: portal-based Tooltip replaces native titles** — `LucidGit_ClaudeCode_Spec.md:L1476-L1497` · `productdocs_global_tooltip`
- **Monthly implementation plan requirements and uncompleted verification checklist** — `docs/superpowers/plans/2026-04-29-contribution-graph.md:L1-L9` · `productdocs_month_plan`
- **Plan clarification: activityUtils file unchanged; widen explicit call argument only** — `docs/superpowers/plans/2026-04-29-contribution-graph-year-view.md:L19` · `productdocs_year_scope`
- **Requirement: computeActivity(1825), unchanged 10000 commit cap** — `docs/superpowers/specs/2026-04-29-contribution-graph-year-view-design.md:L79-L84` · `productdocs_five_year_window`
- **toDateKey()** — `src/lib/activityUtils.ts:L56` · `activityutils_todatekey`
- **Approved year-view redesign requirements, not implementation proof** — `docs/superpowers/specs/2026-04-29-contribution-graph-year-view-design.md:L1-L9` · `productdocs_year_design`
- **Requirement: previous/next year and center reset to current year** — `docs/superpowers/specs/2026-04-29-contribution-graph-year-view-design.md:L13-L31` · `productdocs_year_navigation`
- **contributionData.ts** — `src/lib/contributionData.ts:L1` · `src_lib_contributiondata_ts`
- **fromDateKey()** — `src/lib/activityUtils.ts:L67` · `activityutils_fromdatekey`
- **Planned build and visual acceptance: grid, tooltips, stats, navigation, errors** — `docs/superpowers/plans/2026-04-29-contribution-graph.md:L489-L515` · `productdocs_month_acceptance`
- **Planned flow: ipc.log commits to computeActivity(730) to UTC grid and Tooltip** — `docs/superpowers/plans/2026-04-29-contribution-graph.md:L205-L274` · `productdocs_month_plan_dataflow`
- **Rationale: document.body portal prevents ancestor overflow clipping** — `LucidGit_ClaudeCode_Spec.md:L1478-L1492` · `productdocs_tooltip_clipping_rationale`
- **Requirement: filter date keys by displayed year before calculateStats** — `docs/superpowers/specs/2026-04-29-contribution-graph-year-view-design.md:L86-L101` · `productdocs_year_stats`
- **Requirement: ipc.log all branches with 10000-commit limit** — `docs/superpowers/specs/2026-04-29-contribution-graph-design.md:L58` · `productdocs_commit_log`
- **calculateStats()** — `src/lib/activityUtils.ts:L214` · `activityutils_calculatestats`
- **computeActivity()** — `src/lib/activityUtils.ts:L86` · `activityutils_computeactivity`
- **formatDateForTooltip()** — `src/lib/activityUtils.ts:L192` · `activityutils_formatdatefortooltip`
- **generateWeeks()** — `src/lib/activityUtils.ts:L126` · `activityutils_generateweeks`
- **getMonthLabels()** — `src/lib/activityUtils.ts:L161` · `activityutils_getmonthlabels`
- **Documented limitation: files changed estimated one per commit, no separate PR metric** — `docs/superpowers/specs/2026-04-29-contribution-graph-design.md:L77-L82` · `productdocs_estimated_files`
- **Planned build and visual acceptance: labels, overflow, today, year stats, tooltips** — `docs/superpowers/plans/2026-04-29-contribution-graph-year-view.md:L338-L367` · `productdocs_year_acceptance`
- **Planned single memo produces yearWeeks, monthLabels and overflowKeys** — `docs/superpowers/plans/2026-04-29-contribution-graph-year-view.md:L108-L157` · `productdocs_year_grid_outputs`
- **Requirement: card background, subtle empty cells and responsive SVG width** — `docs/superpowers/specs/2026-04-29-contribution-graph-design.md:L48-L52` · `productdocs_heatmap_style`
- **Requirement: current-day blue one-pixel ring for orientation** — `docs/superpowers/specs/2026-04-29-contribution-graph-year-view-design.md:L105-L116` · `productdocs_today_ring`
- **Requirement: label month-first date's week column inside SVG** — `docs/superpowers/specs/2026-04-29-contribution-graph-year-view-design.md:L55-L75` · `productdocs_month_labels`
- **Requirement: out-of-year cells dim, non-interactive and no tooltip** — `docs/superpowers/specs/2026-04-29-contribution-graph-year-view-design.md:L48-L51` · `productdocs_overflow_cells`
- **Requirement: sparse Mon/Wed/Fri weekday spine** — `docs/superpowers/specs/2026-04-29-contribution-graph-design.md:L54-L56` · `productdocs_weekday_labels`
- **Scope: no month zoom, year animation, lazy per-year loads or light variant** — `docs/superpowers/specs/2026-04-29-contribution-graph-year-view-design.md:L120-L125` · `productdocs_year_non_goals`
- **Tooltip()** — `src/components/ui/Tooltip.tsx:L12` · `tooltip_tooltip`
- **contributionData()** — `src/lib/contributionData.ts:L7` · `contributiondata_contributiondata`
- **getContributionColor()** — `src/lib/activityUtils.ts:L206` · `activityutils_getcontributioncolor`
- **getContributionLevel()** — `src/lib/activityUtils.ts:L75` · `activityutils_getcontributionlevel`

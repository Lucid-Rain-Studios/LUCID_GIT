# Graph Report - H:\LUCID_GIT  (2026-10-10)

## Corpus Check
- 278 files · ~371,638 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2188 nodes · 4887 edges · 43 communities detected
- Extraction: 88% EXTRACTED · 12% INFERRED · 0% AMBIGUOUS · INFERRED: 583 edges (avg confidence: 0.83)
- Token usage: not measured in this run; zero-valued extraction placeholders are not usage evidence.

## Community Hubs (Navigation)
- [Application navigation](wiki/community-0.md)
- [Regression harness and fixtures](wiki/community-1.md)
- [Desktop IPC and authentication](wiki/community-2.md)
- [Git operations](wiki/community-3.md)
- [UI audit and locks](wiki/community-4.md)
- [Asset review contracts](wiki/community-5.md)
- [Asset graphs and contents](wiki/community-6.md)
- [Functional audit and networking](wiki/community-7.md)
- [Repository gates and recovery](wiki/community-8.md)
- [Product requirements and file workflows](wiki/community-9.md)
- [Presence and dependency analysis](wiki/community-10.md)
- [Desktop logs and lifecycle](wiki/community-11.md)
- [Contribution calendar](wiki/community-12.md)
- [Recovery instructions and bug logs](wiki/community-13.md)
- [Unreal configuration and permissions](wiki/community-14.md)
- [Branch switching](wiki/community-15.md)
- [Binary previews and commandlets](wiki/community-16.md)
- [GitHub pull request API](wiki/community-17.md)
- [Index recovery tools](wiki/community-18.md)
- [Hooks and team configuration](wiki/community-19.md)
- [Native graph reader](wiki/community-20.md)
- [Synchronization control rules](wiki/community-21.md)
- [Dependency graph interface](wiki/community-22.md)
- [Repository cleanup](wiki/community-23.md)
- [Mesh preview fixtures](wiki/community-24.md)
- [Diff error recovery](wiki/community-25.md)
- [StateTree binding fixtures](wiki/community-26.md)
- [Renderer startup](wiki/community-27.md)
- [Native asset inventory](wiki/community-28.md)
- [Updater regression fixtures](wiki/community-29.md)
- [Tagged export recovery](wiki/community-30.md)
- [Index recovery UI harness](wiki/community-31.md)
- [Lint configuration](wiki/community-32.md)
- [Browser test configuration](wiki/community-33.md)
- [CSS processing](wiki/community-34.md)
- [Theme configuration](wiki/community-35.md)
- [Renderer build configuration](wiki/community-36.md)
- [Package signing](wiki/community-37.md)
- [Renderer environment types](wiki/community-38.md)
- [Bug log regression](wiki/community-39.md)
- [Error modal regression](wiki/community-40.md)
- [Native reader tests](wiki/community-41.md)
- [Native reader entry point](wiki/community-42.md)

## God Nodes (most connected - your core abstractions)
1. `GitService` - 147 edges
2. `Functional audit: 79/85 findings checked` - 99 edges
3. `Separate UI audit: 1/60 findings checked` - 91 edges
4. `Functional completion requires implemented and verified behavior; regeneration preserves checkbox state` - 86 edges
5. `execSafe()` - 80 edges
6. `docs/UNREAL_ASSET_REVIEW_IMPLEMENTATION.md` - 66 edges
7. `UI acceptance must pass before checking; partial work remains unchecked; shared consumers verified; LG/UI completion tracked independently` - 61 edges
8. `exec()` - 41 edges
9. `docs/BLUEPRINT_REVISION_VIEWER_IMPLEMENTATION.md` - 41 edges
10. `Build specification v2.5: requirements, not verified current implementation` - 34 edges

## Surprising Connections (you probably didn't know these)
- `Documented historical recovery commands: abort merge and remove index.lock` --conceptually_related_to--> `Instruction: preserve caching, deduplication, debounce and bounded recovery`  [AMBIGUOUS]
  docs/troubleshooting/git-lfs-auth-and-index-errors.md → AGENTS.md
- `Documented diagnosis: app authentication can succeed while LFS batch auth fails` --conceptually_related_to--> `Requirement: keychain OAuth token authenticates API and HTTPS Git subprocesses`  [INFERRED]
  docs/troubleshooting/git-lfs-auth-and-index-errors.md → LucidGit_ClaudeCode_Spec.md
- `Guide incident evidence: in-app auth succeeded; LFS a186ac1 batch Bad credentials` --conceptually_related_to--> `Requirement: persistent last-five-session Bug Logs for diagnosing field failures`  [INFERRED]
  docs/troubleshooting/git-lfs-auth-and-index-errors.md → LucidGit_ClaudeCode_Spec.md
- `mutableActorStamp()` --calls--> `execSafe()`  [INFERRED]
  electron/services/ExternalActorReview.ts → electron/util/dugite-exec.ts
- `createKleeCanvas()` --calls--> `wireId()`  [INFERRED]
  tools/blueprint-klee-host.js → src/lib/blueprintGraph.ts

## Hyperedges (group relationships)
- **Shared asset review reuses bounded exact revision capture and compact documents** — assetdocs_host, assetdocs_reuse, assetdocs_capture, assetdocs_lfs, assetdocs_cache, assetdocs_ipc [EXTRACTED 1.00]
- **Saved-data profiles reuse captured host controls and keep broad native/editor/package gates open** — assetdocs_statemachine, assetdocs_blendspace, assetdocs_timing, assetdocs_physicsasset, assetdocs_attachments, assetdocs_acceptance [EXTRACTED 1.00]
- **Firebase workspace presence authorization uses Firebase UID, member rules and main-process REST heartbeat** — assetdocs_workspace, assetdocs_uid, assetdocs_rules, assetdocs_heartbeat, assetdocs_authcache, assetdocs_rest [EXTRACTED 1.00]
- **Visible lock selection and explicit destructive scope** — audits_UI_001, audits_UI_002, audits_UI_003, audits_UI_004, audits_lock_selection_contract [EXTRACTED 1.00]
- **Unreal review remains partial across independent functional and UI audits** — audits_LG_055, audits_UI_059, audits_UI_060 [INFERRED 0.90]
- **Planned contribution data flow: all-branch log, UTC activity, SVG cells and tooltip** — productdocs_commit_log, productdocs_activity_map, productdocs_utc_grid, productdocs_contribution_heatmap, productdocs_svg_tooltip, productdocs_tooltip_metrics [EXTRACTED 1.00]
- **Planned year-view flow: five-year activity, UTC weeks, month labels, overflow and year stats** — productdocs_five_year_window, productdocs_year_grid, productdocs_month_labels, productdocs_overflow_cells, productdocs_year_stats, productdocs_today_ring [EXTRACTED 1.00]
- **Instruction: verify matching finding, update note/checkbox, regenerate stable audit** — productdocs_functional_audit, productdocs_audit_verification, productdocs_audit_generator, productdocs_ui_audit, productdocs_ui_acceptance [EXTRACTED 1.00]

## Communities

### Community 0 - "Application navigation"
Cohesion: 0.01
Nodes (106): ActionBtn(), withAlpha(), applyAppearanceSettings(), hexToRgba(), hexToRgbComponents(), lightenHex(), handler(), typingInField() (+98 more)

### Community 1 - "Regression harness and fixtures"
Cohesion: 0.01
Nodes (82): badge(), checkbox(), Chromium evidence covers graph render, pan/zoom, focus, fullscreen and narrow viewport, Inventory first page 250 rows; existing service bounds preserved, Development requires .NET 10; installed helper is self-contained outside ASAR, diff(), graph(), labels() (+74 more)

### Community 2 - "Desktop IPC and authentication"
Cohesion: 0.03
Nodes (65): AuthService, fetchGitHubProfile(), hasRequiredScopes(), parseScopes(), profileRetryDelayMs(), readData(), refreshKey(), sleep() (+57 more)

### Community 3 - "Git operations"
Cohesion: 0.04
Nodes (20): detectGitSubcommand(), exec(), execSafe(), execWithProgress(), execWithStdin(), gitAuthArgs(), trackGitOp(), estimatedCaptureBytes() (+12 more)

### Community 4 - "UI audit and locks"
Cohesion: 0.03
Nodes (102): UI-001: Use the displayed row order for Shift selection [Unchecked finding; Source-derived reproduction], UI-002: Capture the range anchor before scheduling state updates [Unchecked finding; Source-derived reproduction], UI-003: Make owner selection scope explicit [Unchecked finding; Source-derived reproduction / design choice], UI-004: Right-click must target the clicked row or deliberate selection [Unchecked finding; Source], UI-005: Correct unlock labels and enrich the lock menu [Unchecked finding; Source], UI-006: Give lock selection a real keyboard and checkbox contract [Unchecked finding; Source], UI-007: Bulk-unlock bounded workers and persistent partial results verified by controlled renderer/service and real LFS tests; owner/dirty preview, Retry failed and cancellation remain [Partial; unchecked; Suggestion], UI-008: Share lock inspection and selected-file workflows across surfaces [Unchecked finding; Source / suggestion] (+94 more)

### Community 5 - "Asset review contracts"
Cohesion: 0.01
Nodes (134): Editor ground truth,large-asset measurement,packaged Timeline/PR/merge and cross-platform acceptance remain, Actor ownership bounded: depth32,100 owned rows/actor,1000 across expanded groups, Actor inventory follows saved Level.Actors/verified external ownership with All objects recovery, Sequence/montage metadata and timing schematic reuse captured documents and inspector, Windows/Linux publish x64; macOS publishes x64/arm64 selected by Electron architecture, Saved attachment composition requires explicit finite transforms,positive uniform scale,nonabsolute flags,no socket, Missing/cross-package/ambiguous parents,cycles,defaults/nonuniform scale remain unresolved, LG-055 and UI-060 remain unchecked; documented functional/UI progress 79/85 and 1/60 (+126 more)

### Community 6 - "Asset graphs and contents"
Cohesion: 0.03
Nodes (41): animationTimeline(), enumValue(), number(), record(), CPU/SVG collision preview bounded to64 shapes/20000 vertices/10000 triangles per side, PhysicsAssetPreview pairs unique captured body paths and reuses BlueprintChoice/MeshPreview, Saved SphereElems uses finite center/positive radius and faceted preview topology, savedObjectIndex() (+33 more)

### Community 7 - "Functional audit and networking"
Cohesion: 0.05
Nodes (102): fmtBytes(), sizeDeltaLabel(), LG-001: Shell interpolation in asset extraction [Implemented and verified; Reproduced safely], LG-002: GitHub credentials can reach unrelated hosts [Implemented and verified; Source], LG-003: Index-lock cleanup reopened: bounded age/activity heuristics cannot prove external owner death; packaged/taskkill acceptance unverified [Reopened; ownership risk remains; Source], LG-004: Undo destroys edits made after the checkpoint [Unchecked finding; Reproduced], LG-005: Undo can reset a different branch [Implemented and verified; Source], LG-006: Undo claims success after restoration failure [Implemented and verified; Source] (+94 more)

### Community 8 - "Repository gates and recovery"
Cohesion: 0.04
Nodes (70): BlueprintRevisionService retained as compatible facade; additive family modules preferred to large refactor, LG-055 engine integration,UI-059 context andUI-060 broad dialog acceptance remain separate findings, Required capability coverage separates properties/topology/geometry/hierarchy reconstruction scopes, Approved HTML concept is design baseline; all asset names/counts/previews illustrative, Required normalized contract separates serialized from inherited/resolved values; omitted defaults never zero/false, Historical dependency must use selected tree; index/worktree capture consistency must reject mixed-time snapshots, docs/UNREAL_ASSET_REVIEW_IMPLEMENTATION_PLAN.md, Mesh geometry provider/renderer, skin/LOD/materials and engine fidelity remain unchecked (+62 more)

### Community 9 - "Product requirements and file workflows"
Cohesion: 0.02
Nodes (94): close(), doCopyFullPath(), doCopyRelPath(), doDiscard(), doIgnoreFile(), doIgnoreFolder(), doLock(), doOpenDefault() (+86 more)

### Community 10 - "Presence and dependency analysis"
Cohesion: 0.07
Nodes (34): Rules do not independently verify repo membership; login/name are display labels and GitHub roles do not sync, Timeouts and account/project/workspace auth caching/deduplication keep tokens main-memory only, First admin bootstraps lucidGit/workspace/members/UID record in Firebase Console, Device sessions aggregate Active before Away before Offline; only status/server time sent, Verified diff distinguishes semantic edits, layout and comments; partial sides restrict claims, Disabled role/user blocks access; deleting member record permits auto-registration again, docs/FIREBASE-PRESENCE.md, Controlled HTTP tests do not prove deployed Firebase rules/OAuth; emulator tests rules locally (+26 more)

### Community 11 - "Desktop logs and lifecycle"
Cohesion: 0.07
Nodes (16): LogService, attachWindowDiagnostics(), createWindow(), promptForUpdate(), recoverWindow(), reportUpdateError(), sendToRenderer(), escapeHtml() (+8 more)

### Community 12 - "Contribution calendar"
Cohesion: 0.08
Nodes (37): calculateStats(), computeActivity(), formatDateForTooltip(), fromDateKey(), generateWeeks(), getMonthLabels(), toDateKey(), Specified computeActivity UTC-keyed day map with 730-day monthly window (+29 more)

### Community 13 - "Recovery instructions and bug logs"
Cohesion: 0.07
Nodes (26): Instruction: regenerate functional report and synchronize completion counts, Instruction: complete only after relevant behavior verification, Documented recovery: validate remote/helper/endpoint, clear credentials and reauthenticate, Requirement: persistent last-five-session Bug Logs for diagnosing field failures, Documented historical recovery commands: abort merge and remove index.lock, Instruction: canonical functional audit and stable LG finding IDs, Instruction: query knowledge graph before raw reads, Guide incident evidence: in-app auth succeeded; LFS a186ac1 batch Bad credentials (+18 more)

### Community 14 - "Unreal configuration and permissions"
Cohesion: 0.14
Nodes (11): Requirement: force unlock, destructive history, cleanup and team config admin-gated, Requirement: session-only UI role preview leaves main IPC guards unchanged, Requirement: disabled admin controls remain discoverable and explain access, Requirement: main IPC admin guard prevents renderer bypass, Specified five-minute permission cache and background refresh, Requirement: API failure falls back to write with warning, Specified admin/write/read mapping; maintain treated as write, Rationale: GitHub blocks non-write pushes; admin gates destructive/team config (+3 more)

### Community 15 - "Branch switching"
Cohesion: 0.1
Nodes (9): doCheckoutLocal(), doCheckoutRemote(), doDeleteRemote(), doRename(), executeSwitchTo(), handleContextCreatePR(), openPR(), parseGitHubSlug() (+1 more)

### Community 16 - "Binary previews and commandlets"
Cohesion: 0.23
Nodes (7): AssetDiffService, cacheDir(), dirSizeBytes(), formatBytes(), hash8(), withThumbnailSlot(), UEHeadlessService

### Community 17 - "GitHub pull request API"
Cohesion: 0.25
Nodes (5): ghFetch(), GitHubApiError, GitHubService, retryDelayMs(), sleep()

### Community 18 - "Index recovery tools"
Cohesion: 0.15
Nodes (12): active(), blockerRun(), checkTasks(), diagnose(), recoverLock(), repair(), run(), stopTasks() (+4 more)

### Community 19 - "Hooks and team configuration"
Cohesion: 0.26
Nodes (5): getShell(), hooksDir(), HookService, scriptPreview(), TeamConfigService

### Community 20 - "Native graph reader"
Cohesion: 0.49
Nodes (1): GraphExtractor

### Community 21 - "Synchronization control rules"
Cohesion: 0.23
Nodes (5): busyReason(), createPRDisabledReason(), fetchDisabledReason(), pullDisabledReason(), pushDisabledReason()

### Community 22 - "Dependency graph interface"
Cohesion: 0.2
Nodes (2): buildGraph(), refreshGraph()

### Community 23 - "Repository cleanup"
Cohesion: 0.25
Nodes (6): doPruneLfs(), doShallow(), doUnshallow(), fmt(), loadSize(), ResultBadge()

### Community 24 - "Mesh preview fixtures"
Cohesion: 0.27
Nodes (7): box(), boxObject(), capsule(), capsuleObject(), legacyCapsule(), object(), sphereObject()

### Community 25 - "Diff error recovery"
Cohesion: 0.52
Nodes (1): DiffErrorBoundary

### Community 26 - "StateTree binding fixtures"
Cohesion: 0.38
Nodes (4): binding(), editor(), endpoint(), object()

### Community 27 - "Renderer startup"
Cohesion: 0.53
Nodes (4): bootstrap(), describeError(), getRendererLogger(), reportBootstrapError()

### Community 28 - "Native asset inventory"
Cohesion: 0.8
Nodes (1): AssetExtractor

### Community 29 - "Updater regression fixtures"
Cohesion: 0.4
Nodes (0): 

### Community 30 - "Tagged export recovery"
Cohesion: 1.0
Nodes (1): TaggedExportRecovery

### Community 31 - "Index recovery UI harness"
Cohesion: 1.0
Nodes (0): 

### Community 32 - "Lint configuration"
Cohesion: 1.0
Nodes (0): 

### Community 33 - "Browser test configuration"
Cohesion: 1.0
Nodes (0): 

### Community 34 - "CSS processing"
Cohesion: 1.0
Nodes (0): 

### Community 35 - "Theme configuration"
Cohesion: 1.0
Nodes (0): 

### Community 36 - "Renderer build configuration"
Cohesion: 1.0
Nodes (0): 

### Community 37 - "Package signing"
Cohesion: 1.0
Nodes (0): 

### Community 38 - "Renderer environment types"
Cohesion: 1.0
Nodes (0): 

### Community 39 - "Bug log regression"
Cohesion: 1.0
Nodes (0): 

### Community 40 - "Error modal regression"
Cohesion: 1.0
Nodes (0): 

### Community 41 - "Native reader tests"
Cohesion: 1.0
Nodes (0): 

### Community 42 - "Native reader entry point"
Cohesion: 1.0
Nodes (0): 

## Ambiguous Edges - Review These
- `Instruction: preserve caching, deduplication, debounce and bounded recovery` → `Documented historical recovery commands: abort merge and remove index.lock`  [AMBIGUOUS]
  docs/troubleshooting/git-lfs-auth-and-index-errors.md · relation: conceptually_related_to
- `Specified default remote-tip diff after configurable five-minute fetch` → `Requirement: Pull only after Fetch this session; doPull does not fetch`  [AMBIGUOUS]
  LucidGit_ClaudeCode_Spec.md · relation: conceptually_related_to

## Knowledge Gaps
- **185 isolated node(s):** `InvalidJsonSchema`, `Timeline comparison uses parent/commit, HEAD/index or index/worktree and retains rename identities`, `Serialized export class and supported graph capability determine graph versus binary routing`, `Graph comparison supports stable identities and visibly identified unique graph-name fallback`, `Shared modal isolation and browser fullscreen preserve review state and restore focus` (+180 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Index recovery UI harness`** (2 nodes): `mount()`, `index-recovery-ui.spec.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Lint configuration`** (1 nodes): `eslint.config.mjs`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Browser test configuration`** (1 nodes): `playwright.config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `CSS processing`** (1 nodes): `postcss.config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Theme configuration`** (1 nodes): `tailwind.config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Renderer build configuration`** (1 nodes): `vite.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Package signing`** (1 nodes): `afterSign.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Renderer environment types`** (1 nodes): `vite-env.d.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Bug log regression`** (1 nodes): `bug-logs.spec.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Error modal regression`** (1 nodes): `error-panel-modal.spec.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Native reader tests`** (1 nodes): `Program.cs`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Native reader entry point`** (1 nodes): `Program.cs`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Instruction: preserve caching, deduplication, debounce and bounded recovery` and `Documented historical recovery commands: abort merge and remove index.lock`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Specified default remote-tip diff after configurable five-minute fetch` and `Requirement: Pull only after Fetch this session; doPull does not fetch`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `LG-009: Many repository mutations bypass the write gate [Implemented and verified; Source]` connect `Functional audit and networking` to `Regression harness and fixtures`, `Desktop IPC and authentication`, `Git operations`?**
  _High betweenness centrality (0.169) - this node is a cross-community bridge._
- **Why does `Functional audit: 79/85 findings checked` connect `Functional audit and networking` to `UI audit and locks`?**
  _High betweenness centrality (0.077) - this node is a cross-community bridge._
- **Why does `docs/UNREAL_ASSET_REVIEW_IMPLEMENTATION.md` connect `Asset review contracts` to `Regression harness and fixtures`, `Asset graphs and contents`?**
  _High betweenness centrality (0.068) - this node is a cross-community bridge._
- **Are the 85 inferred relationships involving `Functional completion requires implemented and verified behavior; regeneration preserves checkbox state` (e.g. with `LG-004: Undo destroys edits made after the checkpoint [Unchecked finding; Reproduced]` and `LG-005: Undo can reset a different branch [Implemented and verified; Source]`) actually correct?**
  _`Functional completion requires implemented and verified behavior; regeneration preserves checkbox state` has 85 INFERRED edges - model-reasoned connections that need verification._
- **Are the 78 inferred relationships involving `execSafe()` (e.g. with `.identity()` and `.resolveSide()`) actually correct?**
  _`execSafe()` has 78 INFERRED edges - model-reasoned connections that need verification._

## Scope, freshness and evidence limits

- Lucid Git first-party source, tests, scripts, helper source and documentation; generated, build, cloned dependencies, HTML mockups and media excluded. 278 selected files were hashed in the source manifest.
- AST relationships describe source structure; semantic relationships describe the selected documents. Requirements, historical notes and unchecked audit findings are not current runtime proof.
- 978 AST edges to external or unresolved symbols are omitted by graphify; 18 local imports point outside the selected code scope. File anchors and alias-aware imports improve navigation without resolving dynamic dispatch.
- 513 additional cross-file AST call targets lack matching imports and are excluded from confirmed graph navigation. Their source pointers remain in `.graphify_unresolved_calls.json` with AMBIGUOUS confidence, rather than binding common receiver/callback names to unrelated functions. Indirect calls may be missing; remaining inferred calls are not runtime proof.
- No dependency source, binaries, generated builds, HTML mockups or media were extracted. Audit status was read from the reports; no finding was changed or reverified.
- Semantic evidence line ranges, edge endpoints, confidence scores and selected-document coverage were validated. No live application, Unreal Editor or full runtime verification was performed.


## Retrieval estimate

The built-in four-question benchmark estimates 13.2x less context than reading the full selected corpus. This compares estimated token volumes, not measured model usage, fidelity or retrieval quality. Details are in `benchmark.json`.

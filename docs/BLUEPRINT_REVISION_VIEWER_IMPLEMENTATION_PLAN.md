# Read-only Blueprint revision viewer

Status: implementation plan; no viewer implementation or asset compatibility verified yet.

## Intended behavior

In the timeline, selecting a changed Unreal Blueprint `.uasset` opens its graph representation in the existing changes area. Show the base revision on the left and the selected revision on the right, with nodes, pins, wires, comments, and saved node positions. A Full screen action expands the same comparison into a full-window review surface and supports entering actual application full screen. Escape returns to the previous view without losing selection or camera position.

The viewer is strictly read-only. Users can navigate, select nodes, inspect properties, select graphs, and review changes. They cannot move nodes, change defaults, create or delete nodes, reconnect pins, or save an asset. No Unreal Editor installation should be required for supported editor-saved Blueprint files.

Not every `.uasset` contains a Blueprint graph. Other asset classes retain their existing binary view, with a clear explanation when graph viewing is unavailable. Cooked assets, malformed files, missing revision data, and unsupported serialization must never produce an invented or silently incomplete graph.

Visual reference: [interactive HTML concept](C:/Users/ricar/.codex/visualizations/2026/10/09/01a120d1-755e-7e50-b072-2a80ede6a6ed/blueprint-revision-viewer.html). This is an illustrative mockup, not a working asset reader. Use its side-by-side structure and change inspector; derive production colors, spacing, and typography from the app's design system. This link points to the local mockup and is not portable to other machines.

## Evidence and integration boundaries

Project knowledge-graph navigation identifies these candidate integration points:

| Candidate | Graph evidence | Planned responsibility |
| --- | --- | --- |
| `src/components/diff/BinaryDiff.tsx` | `BinaryDiff()` at L313; `classifyAsset()` at L17 | Route supported Blueprint assets to the graph comparison; preserve other binary views. |
| `electron/services/GitService.ts` | Git service and LFS methods, including `lfsStatus()` at L591 | Reuse revision retrieval, Git execution, and authenticated LFS infrastructure where available. |
| `src/ipc.ts` | IPC module; architecture documentation describes main/renderer IPC | Add typed, narrowly scoped read requests and serialized results. |
| Timeline file-selection handler | Not established by the graph | Locate the actual timeline-to-diff route before integration. |

`graphify-out/wiki/index.md` is absent. The graph provides navigation evidence, not confirmation of current source behavior. Do not assume these locations or line numbers remain current. Before implementation, query the graph again and obtain scoped authorization to read the relevant source, build configuration, and audit reports under the project's raw-file policy.

Candidate dependencies:

- [UAssetAPI](https://github.com/atenfyr/UAssetAPI): MIT-licensed .NET asset reader. Use it in a local helper process, exposing only extraction operations. Its advertised engine-version range is a starting point for compatibility testing, not a guarantee of complete graph extraction.
- [Klee](https://github.com/joined-forces/klee): MIT-licensed web Blueprint renderer. Wrap it behind an app-owned viewer interface.
- [Klee Redux](https://github.com/Geijoh/klee-redux): candidate rendering improvements and lifecycle hooks. Verify the exact fork's license and dependency notices before choosing it. Its node dragging and clipboard features must be disabled or omitted for this viewer.

Klee accepts Unreal graph clipboard text. UAssetAPI exports asset objects; it does not supply a ready-made Klee graph. The extraction and conversion adapter is the main feasibility risk. Prototype that adapter before integrating timeline UI.

## Architecture

```text
Timeline selection: repository + comparison + file identity
  -> existing diff routing
  -> Blueprint revision service in Electron main
     -> resolve exact revision bytes and LFS objects
     -> bounded local extraction helper using UAssetAPI
     -> normalized graph document + completeness diagnostics
     -> graph/node/pin comparison
  -> typed IPC result
  -> React comparison surface
     -> Klee adapter and read-only canvases
     -> graph selector, change inspector, synchronized cameras
     -> expanded/full-screen presentation
```

The renderer does not receive unrestricted filesystem access or run Git/helper commands. The main process validates repository membership, revision identifiers, and paths. Run extraction outside the Electron main thread. Serve viewer scripts locally with the application's existing security policy; do not send assets or graphs to a website.

Suggested new modules, subject to source verification: `BlueprintRevisionService`, a .NET `BlueprintExtractor` helper, shared graph types, `BlueprintDiff`, and `BlueprintCanvas`. Prefer existing repository conventions over introducing a parallel infrastructure.

## Phased implementation checklist

All boxes below represent unfinished work. Complete a phase only when its exit condition passes.

### Phase 1 — Verify feasibility with real assets

- [ ] Locate the actual timeline file-selection route, diff contracts, revision retrieval, LFS recovery, cache, cancellation, and app fullscreen conventions.
- [ ] Read both functional and UI audit reports with scoped authorization; record applicable `LG-` and `UI-` IDs without assuming a baseline defect is still present.
- [ ] Select and pin dependency versions and document licenses, notices, supported platforms, and helper packaging.
- [ ] Build a read-only extraction spike for one simple and one representative complex editor-saved Blueprint from the target UE version.
- [ ] Extract event graphs, function graphs, macro graphs, collapsed graphs, node identities/classes, saved positions, comments, pin identities/types/defaults, and both execution and data links.
- [ ] Detect custom node/pin serialization and unsupported exports; return explicit diagnostics instead of silently dropping objects.
- [ ] Convert one extracted graph into Klee-compatible text or an explicitly supported renderer input. Do not assume JSON can be passed directly to Klee.
- [ ] Compare node counts, pin counts, connectivity, positions, and graph names against Unreal Editor ground truth. Retain reproducible fixtures and expected results.
- [ ] Verify the chosen renderer can enforce read-only behavior and accept host-controlled cameras, node selection, and diff decorations.

Exit condition: real `.uasset` bytes render a faithfully connected graph locally, without opening Unreal. If extraction or renderer requirements fail, resolve that limitation or revise the dependency choice before building the timeline feature.

### Phase 2 — Retrieve exact revision bytes

- [ ] Define a comparison descriptor with repository identity, comparison mode, old/new paths, and resolved old/new revision or content identities.
- [ ] For a normal commit, compare that commit with the parent selected by existing timeline semantics. For a root commit, use an absent base. Preserve existing merge-parent selection; show which parent is being compared.
- [ ] If the existing timeline exposes staged or working-tree comparisons, reuse its modes: HEAD versus index for staged changes, index versus working tree for unstaged changes. Do not substitute local files for a historical revision.
- [ ] Handle renamed paths, added files, deleted files, and graphs present on only one side.
- [ ] Recognize Git LFS pointer bytes before extraction. Resolve exact object IDs through the existing authenticated recovery path; avoid repository-wide downloads, repeated fetches, and indefinite retries.
- [ ] Keep missing or offline objects distinct from unsupported assets and parser failures. Allow deliberate retry of a missing side.
- [ ] Materialize revision bytes and any required companion package files into an app-managed temporary area without checkout, index writes, or workspace changes. If required companions cannot be obtained, report that explicitly.
- [ ] Capture working-tree content consistently; invalidate by content identity when the file changes and prevent stale results from replacing a newer selection.

Exit condition: each comparison side displays the selected revision's bytes, including LFS, without changing repository state.

### Phase 3 — Extraction service, contracts, and performance

- [ ] Define a normalized document containing asset class, engine/version diagnostics, graphs, nodes, pins, edges, comments, and extraction completeness. Retain enough source data to build the renderer adapter.
- [ ] Use explicit result states: loading, complete, partial, unsupported, missing content, failed, and absent side. Unknown data is never equivalent to unchanged data.
- [ ] Keep the helper's exposed command/API extraction-only, despite the underlying library supporting writes.
- [ ] Validate paths and arguments; enforce process timeout, input/output size limits, and bounded concurrency. Handle malformed assets without freezing or crashing the app.
- [ ] Cache normalized documents by asset content hash, companion identities, engine/mapping configuration, extractor version, and schema version. Bound memory/disk usage and evict old entries.
- [ ] Deduplicate matching in-flight reads/extractions; cancellation by one viewer must not abort work still needed by another consumer.
- [ ] Cancel obsolete subscriptions when switching files or revisions. Suppress stale responses. Preserve existing watcher debounce and safe read preemption.
- [ ] Avoid repeated full asset scans, repeated extraction during pan/zoom, and full JSON IPC transfers when reopening cached content. Measure representative payload sizes.
- [ ] Bundle the .NET helper appropriately for each supported release platform; verify packaged execution and license notices without relying on a developer-installed runtime.

Exit condition: typed read requests return bounded, diagnosable graph data; repeated viewing reuses work and rapid selection stays responsive.

### Phase 4 — Compute meaningful graph changes

- [ ] Match graphs by serialized stable identity where available, then a documented path/name strategy. Represent added and removed graphs explicitly.
- [ ] Match nodes by stable node GUID and pins by stable pin identity. Use conservative, qualified fallbacks when identities change; expose ambiguous matches.
- [ ] Compare node presence, serialized properties/defaults, pin types/defaults, and connection endpoints. Keep execution links and data links distinguishable.
- [ ] Report saved layout moves and comment changes separately from logical/property changes.
- [ ] Preserve actual authored positions on each side. Synchronized cameras must not silently rearrange either graph.
- [ ] Label added, removed, and modified nodes/wires with text or shapes as well as color. Keep change counts traceable to concrete items.
- [ ] Treat byte changes with no supported graph changes honestly: show that graph comparison found no differences and that other asset data may have changed.
- [ ] When either side is partial, show its diagnostics and restrict comparison claims to verified data; offer the existing binary view.

Exit condition: fixtures for node additions/removals, default edits, rewiring, layout-only moves, and changed identities produce correct, explainable results.

### Phase 5 — Timeline UI and read-only interaction

- [ ] On timeline `.uasset` selection, detect actual asset class rather than relying on filename prefixes. Open supported Blueprint graph comparisons in the changes area by default.
- [ ] Display base/selected revision labels, hashes or working-tree identity, and the asset path. Use “Working tree” only for actual working-tree comparisons.
- [ ] Add paired graph selection for Event Graphs, functions, and macros, with explicit absent-side states. Navigate collapsed graphs and supported internal references within the extracted document.
- [ ] Add independent or synchronized pan/zoom, fit graph, selection, node/property inspection, and previous/next change navigation.
- [ ] Show a change list; selecting an item focuses the relevant node or wire on the applicable side(s).
- [ ] Disable node dragging, wire editing, editable property controls, mutation shortcuts, delete actions, and save operations at both renderer and host boundaries. Panning must not mutate saved positions.
- [ ] Add keyboard navigation, focus visibility, accessible change descriptions, and a keyboard-operable companion list for canvas nodes.
- [ ] Provide loading, one-sided, no-graph, missing LFS, incomplete, and error states without hiding the timeline or blocking other file selection.
- [ ] Keep the existing binary details available as a fallback and optional alternate view. Initially scope support to verified Blueprint graph types; do not imply materials, animation state machines, or widget layout trees are implemented.

Exit condition: clicking a supported changed Blueprint in the timeline opens a usable, faithful read-only comparison. Unsupported assets keep a useful existing view.

### Phase 6 — Expanded and full-screen review

- [ ] Add a visible Full screen control in the comparison toolbar.
- [ ] Expand the review surface to fill the app window, hiding unrelated navigation while retaining both revisions, graph selection, the change inspector, and an obvious exit control.
- [ ] Offer or enter actual application full screen through the existing Electron window boundary; restore the prior window fullscreen state on exit.
- [ ] Preserve graph, revision pair, cameras, selected change, synchronization setting, and loading state through expansion and collapse. Reuse loaded documents; do not re-extract assets.
- [ ] Support Escape, restore focus to the launch button, and clean up window listeners. If Escape is consumed by a nested interaction, a subsequent Escape must still exit review.
- [ ] Resize canvases correctly and dispose renderer animation loops/listeners on unmount. If using Redux, verify its documented `destroy()` lifecycle in the pinned version.

Exit condition: full-screen review works in the packaged app and restores both UI and window state without losing review context or leaking resources.

### Phase 7 — Acceptance, packaging, and audit updates

- [ ] Verify an actual timeline commit click, graph selection, change navigation, fullscreen entry, Escape exit, and return to the same selected file in the running app.
- [ ] Test root commits, chosen merge parents, renames, additions, deletions, and graph additions/removals. Test staged/unstaged modes if exposed by the existing timeline.
- [ ] Test locally available LFS, authenticated recovery, unavailable remote objects, and offline operation; confirm no repeated fetch loop.
- [ ] Test rapid file/revision switching, cancelled requests, deduplicated consumers, large Blueprints, helper timeouts, and malformed assets.
- [ ] Confirm read-only invariants: asset hashes, index state, worktree status, node positions, pin links, and defaults remain unchanged after all supported interactions and attempted mutation shortcuts.
- [ ] Validate each supported UE version with real editor-saved fixtures. Publish a tested compatibility matrix; distinguish validated support from best-effort parsing.
- [ ] Verify packaged helper startup and graph rendering on supported platforms, with Unreal closed and no development tooling installed.
- [ ] Record extraction/render timings, cache reuse, resource usage, and canvas cleanup on representative small and large graphs. Set measured budgets before release rather than inventing targets.
- [ ] Check accessibility, legibility, zoom, narrow-window behavior, and full-screen visuals in the live app. Preserve production styling; do not treat the HTML concept as acceptance evidence.
- [ ] For applicable findings that are fully resolved, update the functional/UI resolution notes, check only verified items, and regenerate the relevant reports using their existing generators. Keep `LG-` and `UI-` IDs separate, preserve Undo and optimization work, and leave partial findings unchecked.

Exit condition: the packaged app passes the agreed real-asset acceptance set, with accurate audit notes and no regression in existing text/binary diff behavior.

## Release sequence and stop condition

Implement in dependency order: extraction proof → exact revision retrieval → normalized service/cache → graph comparison → timeline viewer → fullscreen → packaged acceptance. Gate production routing behind successful extraction and compatibility tests. Keep the existing binary view available throughout rollout.

The first release is complete when a user can select a verified Blueprint `.uasset` change in the timeline, review both revision graphs and their meaningful differences, enter and exit fullscreen, and return to the same review state without modifying assets or repository state. Asset editing, graph saving, Unreal Editor bridging, merging Blueprints, material previews, and general asset visualization are separate future work.

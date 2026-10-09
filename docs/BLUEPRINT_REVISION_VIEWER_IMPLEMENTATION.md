# Blueprint revision viewer: implementation and verification

Updated 2026-10-09. Core implementation is integrated; release acceptance is still partial. The [phase checklist](BLUEPRINT_REVISION_VIEWER_IMPLEMENTATION_PLAN.md) records completed work without treating component tests as running-app acceptance.

## What is implemented

- Timeline `.uasset` selection requests a Blueprint comparison in the existing right pane. Committed files use the first parent and selected commit; root/add/delete sides can be absent. Staged files use HEAD/index; unstaged files use index/worktree. Rename identities are retained, including an unstaged edit after a staged rename.
- A .NET extraction-only helper reads actual package bytes through UAssetAPI and independently decodes native graph pins. It preserves saved coordinates, graph/node GUIDs, tagged properties, comments, pin types/defaults and references. Unsupported native tails, malformed identities and unresolved links produce diagnostics.
- Klee renders graph clipboard text generated from those normalized records. The host never constructs Klee's editable Application/Controller. Its API exposes cameras, selection, decorations and disposal; no graph writes or saves are exposed. Upstream debug drawing and webpack-only plugin discovery are adapted during bundling without editing the dependency checkout.
- Side-by-side graphs support graph selection, synchronized or independent cameras, pan/zoom, fit, previous/next change, node inspection, an accessible node list and binary-details fallback. Changes match stable identities; unique graph-name fallback is identified visibly. Unknown revisions cannot appear as added/deleted nodes.
- Full-screen review uses the shared modal focus/isolation shell and the browser fullscreen API available to the Electron renderer. It preserves loaded documents, graph selection, camera state and selected node, supports Escape, restores launcher focus and disposes old canvases.
- UI surfaces use the app's theme, spacing, radius and font variables. Canvas text/grid/background follow app tokens; Unreal node/pin category colors remain useful visual context. The inspector becomes an overlay in narrow panes rather than squeezing both graphs.

## Dependencies and builds

Pinned build-time repositories:

| Dependency | Commit | License |
| --- | --- | --- |
| UAssetAPI | `3228c1e86261aa08131f7ec0ff1a395f5d0b2a84` | MIT |
| Joined-Forces/Klee | `3c694f280ea1702624f81e7b0d20b9292d635cc5` | MIT |

```powershell
npm run blueprint:setup   # Clone missing dependencies; preserve mismatched existing checkouts and fail clearly
npm run dev              # Builds the local reader and renderer bundle before starting the app
npm run build            # Builds tools, typechecks main/renderer and bundles the app
npm run blueprint:publish # Produces self-contained release readers and complete license notices
```

Development needs the .NET 10 SDK. Installed applications use a self-contained helper outside ASAR and need no Unreal installation or developer .NET runtime. Windows/Linux publish x64; macOS publishes both x64 and arm64 helpers, selected by the running Electron architecture. CI and release workflows prepare the pinned repositories; the installed app never clones or downloads renderer code.

The helper ships complete UAssetAPI, Newtonsoft.Json, ZstdSharp and .NET license/notice files. Klee's complete license is shipped with its renderer bundle. Engine sample assets and Epic engine source are not redistributed.

## Revision retrieval and bounds

Git/index identities are resolved to immutable blob IDs, including `.uexp` companions. Content capture reuses the existing asynchronous Git/LFS extraction and exact-origin authentication. Captured worktree LFS pointers are smudged into temporary files and verified against their OID/size; the original file remains untouched.

Repository read slots cover identity resolution and byte capture. CPU extraction runs after releasing the slot. Renderer cancellation detaches obsolete subscriptions; shared extraction keeps its own bounded lifetime. App shutdown stops owned helper processes and rejects queued extraction.

Current limits are 256 MB per asset/companion, 20,000 graph nodes, a 25-second helper deadline, 32 MB helper output, two simultaneous helpers and eight queued helper jobs. Document/identity caches retain at most eight entries each; normalized disk cache is pruned to 256 MB. Cache keys include asset/companion content and extractor/schema version. These are implementation ceilings, not measured large-project performance guarantees.

Reopening a review reuses captured identities and normalized documents. IPC still retransmits the normalized document when a component is reopened; renderer document-handle caching remains unfinished.

## Verified evidence

Real binary fixture coverage, rather than a general engine-version guarantee:

| Asset | Recorded UE version | Graphs | Nodes | Pins | Link references | Reader result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| UAssetAPI `TestActorBP` | 4.27.2 | 2 | 4 | 9 | 0 | Complete |
| UAssetAPI `BP_FirstPersonCharacter` | 5.7.4 | 4 | 37 | 130 | 70 | Complete; reciprocal links checked |
| Local engine `BP_Sky_Sphere` | 5.0.0 | 4 | 122 | 409 | 290 | Complete |
| Local engine `StandardMacros` | Engine sample | 24 | 227 | Not recorded | Not recorded | Complete; macro graph inventory checked |

The local 5.0 asset is distributed with the installed UE 5.6 engine. That installation version must not be confused with the asset's recorded save version. Function graphs, comments, real pins and macros are exercised by these fixtures; collapsed graphs still need a dedicated acceptance fixture.

The Windows self-contained executable parsed the first three fixtures. It also parsed the simple fixture with SDK/runtime directories removed from its child PATH, nonexistent DOTNET_ROOT/DOTNET_ROOT_X64 values and multilevel lookup disabled. This verifies bundled runtime lookup locally; it is not a clean-machine installer test. One local timing sample was 1,616 ms for its first launch, then 278 ms and 348 ms for the two larger assets. Normalized payloads were 8,121 / 115,816 / 336,903 bytes. These samples include process startup and are not benchmarks. The self-contained Windows output occupies approximately 88.8 MB before installer compression.

Tests in `tests/blueprint-viewer.spec.js` and `tests/blueprint-diff.spec.js` cover real extraction, canonical Unreal GUIDs checked against original binary bytes, reciprocal UE 5.7 links, root/rename/index/worktree/deletion identities, malformed data, concurrent caching, local LFS, file/index/worktree preservation, default and connection changes, layout changes, ambiguous graph matches and stale subscription responses. A paused-extraction regression verifies that a repository write can acquire its slot immediately. Real Chromium renders the 5.7 character, pans/zooms, inspects/focuses a changed node, expands/exits review, restores focus, opens fallback and checks a 560px viewport without browser errors.

A broader 45-test run passed, including existing asset extraction/authentication, stale preview and shutdown regressions. The focused suite was subsequently expanded to eight checks. Production TypeScript and Vite builds pass. Existing Vite chunk-size/Browserslist notices remain.

## Remaining release acceptance

- Verify the running desktop Timeline click path and packaged graph rendering, using the user's actual Unreal project and relevant history.
- Compare normalized graphs against Unreal Editor ground truth, including collapsed graphs, custom nodes, split pins, maps/sets, delegate signatures and changed identities.
- Exercise authenticated remote LFS recovery, offline/missing objects and required companion failures. Local LFS and credential scoping are verified; no private remote was contacted.
- Add dedicated wire decorations and separate comment-change classification. Currently connection/comment changes mark their owning node modified; saved layout moves are separate.
- Complete stress/resource tests, helper-deadline and queue/shutdown acceptance, and renderer cleanup measurements on large graphs.
- Verify macOS/Linux helper execution, signing and fullscreen window restoration in actual packaged applications. Build configuration is present; those platforms have not been run here.
- Verify all read-only interaction invariants in the running app, including attempted paste/delete/node/wire edits. Fixture files and local LFS worktree/index remain unchanged in the existing checks.

Cooked packages, non-Blueprint assets, non-K2 schemas, unknown native serialization and unversioned packages needing external mappings are not advertised as supported. They retain diagnostics and the binary fallback. Material graphs, animation state machines, widget layout trees and editing/merging are outside this feature.

## Audit tracking

LG-055 remains unchecked because this standalone reader does not implement the existing Unreal commandlet integration. UI-060 remains unchecked because the new review's browser checks do not resolve every custom dialog's acceptance. Their notes were updated and both report generators were run. No new audit item was closed; progress remains 79/85 functional and 1/60 UI.

## Automatic Unreal project metadata (2026-10-09)

Repository open, explicit/background refresh and completed branch checkout trigger asynchronous `.uproject` discovery. The repository store shares the result with Sidebar auto visibility, the Unreal header and Blueprint review; late results cannot cross repository sessions. The viewer shows project name and associated UE version, with the full manifest path and association in its tooltip. This current project metadata never overrides a historical asset's recorded save version or changes parser inputs.

Discovery prefers the root, then deterministic breadth-first traversal to three directory levels, capped at 256 directories. Generated/cache/asset/plugin/dependency trees and symlink directories are skipped; manifests are capped at 1 MB. Concurrent probes are deduplicated, and subsequent refreshes read current files. A repository with multiple manifests uses the first deterministic match; project selection and deep monorepo discovery are not implemented. Numeric `EngineAssociation` values are displayed as versions. Custom build IDs, blank associations and malformed manifests show an unknown version while retaining the project path; installed custom-engine registry resolution is not implemented.

Four detection regressions cover root/nested discovery, exclusions, version edits/deletion, malformed/custom associations, in-flight deduplication, stale repository responses and nested project plugin/configuration paths with preservation of existing INI contents. The broader feature/repository regression run passed 57 checks. The real-browser Blueprint regression also checks the visible project metadata and path tooltip. All four discovery/configuration checks passed after the final nested setup adjustment.

## Embedded navigation and UE 5.8 pin decoding correction (2026-10-09)

The embedded toolbar now includes a keyboard-operable Graphs & files menu. It selects graphs/functions and changed Blueprint files from the existing Timeline selection list, preserving staged/unstaged identities. Menu dismissal supports outside click and Escape; an open menu consumes the first Escape before fullscreen dismissal. Review height is bounded to its parent and navigation remains in the embedded toolbar.

The supplied OGS error was reproduced on a read-only temporary copy of BP_ShooterWeaponBase.uasset (recorded UE 5.8.3). Its localized base FText histories append translator developer notes at Fortnite-main custom version 260. The reader previously left these bytes unread and shifted subsequent pin fields, causing index/stream errors and unresolved links. The independent decoder now consumes the field only at the required serialized custom version. No Unreal source or project asset is distributed. Extractor cache version 5 invalidates previously incomplete normalized documents after app restart.

Before the correction the asset reported 156 diagnostics. After correction it reports complete: seven graphs, 180 nodes, 472 pins and 300 link references, with no diagnostics. Every endpoint resolves within its graph and all references have reciprocal links. This is local compatibility evidence, not a blanket UE 5.8 guarantee or a historical revision ground-truth check.

Nine automated regressions passed, including five synthetic localized-text alignment/truncation checks, existing UE 4.27/5.7 fixtures, local revision/LFS preservation, camera and stale subscription behavior. The real Chromium test now asserts actual execution/data Bezier wire drawing, switches graphs without fullscreen and selects another file at 560x400. The same browser test passed using the real OGS temporary copy, including its seven graph choices, canvas connections, inspection and fullscreen. Tests do not write the original project or copy proprietary fixtures into version control.

## BP_Pickup cast and stale-reader correction (2026-10-09)

The second report was reproduced against BP_Pickup. The current decoder already handled its localized text, but rejected the DynamicCast one-byte purity enum (Fortnite-main custom version 85), discarding its valid pins and leaving connected nodes unresolved. The decoder now reads and validates Pure/Impure/UseDefault for object/class cast nodes, preserves the native state in node properties and keeps already decoded pins if later native data remains unsupported. Unknown data still marks the node incomplete; it is not claimed unchanged.

Reader version 6 is included in every normalized response and validated by the service and disk cache. A stale helper now returns an explicit update/rebuild message instead of feeding old parser output into the viewer. Retry reading bypasses the selected identity/document caches and performs a fresh extraction, while identical comparison-side content shares one forced extraction. Repeated diagnostics are deduplicated, and an incomplete graph is labeled incomplete in the change summary.

The read-only working copy parses completely: 20 graphs, 161 nodes, 534 pins, 332 connection references. The exact indexed bytes were copied from Git/local LFS without changing the index/worktree and also parse completely: 156 nodes and 314 references. EventGraph contains 11 nodes and eight unique wires on each side. The browser check counts actual execution/data Bezier drawing for both canvases and matches every decoded EventGraph connection, rather than merely checking for some wire drawing.

Final verification: all 11 focused regressions pass, including the actual Retry button requesting fresh extraction, diagnostic deduplication, incomplete summary labeling, 13 native-data/text checks, cache/helper compatibility, revision/LFS preservation and canvas interaction. The browser regression also passes with the exact frozen BP_Pickup Index and Working copies. The self-contained Windows reader decodes both Pickup and ShooterWeaponBase completely. This verifies the component and reader; the running desktop Timeline still needs to load the updated build.

## Inactive compiler banner correction (2026-10-09)

Klee displays ERROR when saved ErrorType is 1 and ErrorMsg exists, even when that string is empty. Unreal gates its compiler banner on bHasCompilerMessage instead. The app-owned graph-text adapter now passes ErrorType/ErrorMsg to Klee only when that flag is true. It leaves the decoded saved properties intact for inspection and revision comparison. Browser checks cover an absent flag, false flag and active error with an empty message, confirming inactive banners disappear and active banners remain. This is saved revision metadata, not a live Unreal compilation result.

## Graph dropdown change indicators (2026-10-09)

Graph/function options now display decoded node change counts, including layout changes, plus added/removed indicators. Incomplete graphs and unavailable comparisons are labeled explicitly; complete graphs with no decoded changes retain their name. Each graph comparison is memoized for the current revision result and reused by the selected graph. Fourteen focused regressions pass, covering changed/unchanged/layout/added/removed/incomplete/unavailable labels and real Chromium graph selection with the new labels. Native dropdown styling and graph selection keys are preserved.

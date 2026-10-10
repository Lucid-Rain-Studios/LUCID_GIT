# Unreal asset contents, changes and previews

Created: 2026-10-09. Status: planning complete; implementation and asset-type acceptance not started.

## Approved outcome

Use the user-approved [interactive concept](visuals/unreal-asset-review.html) as the visual and interaction baseline. Its [editable source](visuals/unreal-asset-review.fragment.html) is preserved in the repository so the reference does not depend on a chat-local path. All asset names, counts, changes and previews in the concept are illustrative. The user most recently explored Animation Blueprint → Preview; that surface is part of the intended outcome alongside maps, meshes and StateTrees.

Selecting an Unreal asset in Timeline opens a read-only review in the existing changes/details surface. Preserve the concept's compact asset navigation, filename/path, explicit revision pair, Changes / Contents / Preview views, selectable change list, before/after inspector and coverage footer. Use production theme tokens and existing controls rather than copying the mockup's literal palette or creating another application shell.

| View | Desired behavior |
| --- | --- |
| Changes | List added, removed and modified actors, states, graph elements or properties. Selecting a change shows the actual base/selected values and focuses the corresponding preview when supported. |
| Contents | List decoded contents of the selected side. Allow base/selected inspection, including a deleted asset's base. Identify names, types, property paths and references. |
| Preview | Show a map spatial view, mesh, StateTree hierarchy or animation graph as appropriate. Support revision selection and change highlighting; retain existing paired Blueprint canvases and fullscreen interaction. |
| Coverage | Always distinguish decoded data, unresolved references, omitted payloads and approximate visual reconstruction. A complete property subset is not a complete asset. |

Deliver these four asset families first. Texture/image, animation-sequence playback, materials, data tables/assets and other graph types follow through the same capability model. PR/merge entry points and engine-backed rendering are later integrations, not prerequisites for the first Timeline release.

## Current source and reuse

The graph was queried before reading source. `graphify-out/wiki/index.md` is absent and the graph lacks the current Blueprint pipeline; direct source inspection supplies the implementation evidence below. The checkout already contains ongoing Blueprint changes: preserve them and the existing acceptance checklist.

| Existing location | Verified boundary / planned reuse |
| --- | --- |
| `src/components/timeline/TimelinePanel.tsx` | Supplies selected comparison refs and a `.uasset` file list to the details panel. Extend selection/navigation to maps and grouped external actors. |
| `src/components/shared/FileDetailsSidePanel.tsx` | Routes `.uasset` to `BlueprintDiff` with binary fallback. Add asset-family routing here; retain other file behavior. |
| `electron/services/BlueprintRevisionService.ts` | Resolves historical/index/worktree bytes, `.uexp` companions, cache identities and bounded helpers. Currently validates `.uasset` only. Reuse the capture logic before widening formats. |
| `electron/services/AssetDiffService.ts` | Existing asynchronous binary capture and authenticated LFS recovery. Reuse exact content identities and error handling. |
| `electron/blueprintTypes.ts`, `src/ipc.ts`, `src/lib/blueprintClient.ts` | Typed Blueprint documents/comparisons and compact renderer document reuse. Extend additively without breaking current callers. |
| `tools/BlueprintExtractor/GraphExtractor.cs` | Recognizes Blueprint/WidgetBlueprint/AnimBlueprint, but selects exact `EdGraph` exports with K2 schema. Actual AnimGraphs/state machines require additional class/schema support. |
| `third_party/UAssetAPI/UAssetAPI/ExportTypes/LevelExport.cs` | Decodes actor indices and some native level fields; explicitly leaves remaining native fields unimplemented. Map support must be proven on fixtures. |
| `src/components/diff/BlueprintDiff.tsx`, `.css`, `src/lib/blueprintGraph.ts`, `blueprintKlee.ts` | Existing read-only interaction, graph comparison, inspector, theme and fullscreen behavior. Preserve graph-specific behavior during integration. |
| `scripts/build-blueprint-tools.cjs`, `scripts/setup-blueprint-deps.cjs`, `package.json` | Existing pinned dependencies and self-contained helper build/publish path. Extend only after a decoder is selected. |

Baseline bounds found in the service: 256 MB per input/companion, 256 MB disk cache, two active helpers, eight queued jobs, 25-second helper timeout, 32 MB helper output and eight cached documents/identities. Preserve these initially. Set separate measured ceilings for dependency bundles and geometry; do not multiply limits by every referenced asset. Existing Blueprint release acceptance remains governed by its [plan](BLUEPRINT_REVISION_VIEWER_IMPLEMENTATION_PLAN.md) and [evidence](BLUEPRINT_REVISION_VIEWER_IMPLEMENTATION.md).

## Dependency decisions and feasibility gates

Keep UAssetAPI as the initial property/package reader and Klee for supported Blueprint rendering. Investigate CUE4Parse as an additional native geometry/texture/animation decoder, not an automatic replacement. A parser's engine-version range does not establish fidelity for every class or uncooked format.

| Candidate | Role | Adoption gate |
| --- | --- | --- |
| [UAssetAPI](https://github.com/atenfyr/UAssetAPI) / [UAssetGUI](https://github.com/atenfyr/UAssetGUI) | Existing reader; GUI useful for low-level inspection | Pin existing reader; prove map/StateTree fields and undecoded native tails against editor ground truth. |
| [Klee](https://github.com/Joined-Forces/klee) | Reuse current graph renderer | Prove pose pins, nested animation graphs and state-machine transitions; add specialized rendering where generic nodes are misleading. |
| [CUE4Parse + conversion library](https://github.com/FabianFG/CUE4Parse) | Mesh/texture/animation decoding; project documents these types and Apache-2.0 licensing | Test actual uncooked target-version fixtures, bulk-data layouts, dependencies, output size and packaged native dependencies. Pin commits and include notices. |
| [FModel](https://github.com/4sval/FModel) | Reference for useful previews and asset inspection | Its GPL-3 application is not a planned embedded dependency. Review any proposed code reuse separately. |
| [ThreeNative asset conversion](https://github.com/jonit-dev/threenative-asset-mcp/blob/main/README.md) | Research candidate for source-mesh/map-to-GLB conversion | README reports selected editor-asset coverage, not universal support. Inspect source, licenses/transitive tools, fixtures and accuracy before reuse. No auto-installing external toolchains in the installed app. |
| Bundled web 3D renderer, e.g. Three.js | Local mesh/spatial previews | Select/pin after output-format spike; verify resource disposal, bounded GPU allocation and offline packaging. No dependency currently selected. |

If standalone extraction cannot faithfully decode an asset profile, retain useful verified properties and a clear limitation. An optional Unreal Editor plugin/commandlet can later provide that profile. Do not require Unreal for profiles proven to work standalone, or imply an engine integration already exists.

## Shared architecture and data contracts

```text
Timeline comparison + selected asset / owning map
  → existing main-process revision and LFS capture
  → immutable package/dependency manifest for each side
  → bounded extraction provider, chosen by serialized class and capabilities
  → versioned asset document + scope-specific diagnostics
  → deterministic contents/change comparison
  → Changes / Contents / Preview + existing binary fallback
```

Start with small shared capture functions and additive contracts. Keep `BlueprintRevisionService` as a compatible facade while adding other families; avoid a large rename/refactor before a map vertical slice works. Suggested new modules are an asset document contract, per-family extractors/comparators, an asset review host, contents/property panels and specialized previews. Final paths should follow existing conventions.

The normalized document must record:

- Serialized class, asset kind, saved engine/custom versions, reader/schema versions and content identity. Route by serialized class; extensions only identify package candidates.
- A manifest of root package, required companions and resolved dependencies, each with side-specific path/content identity. Include `.uexp`, `.ubulk`, `.uptnl` and package-trailer/virtualized payload requirements when applicable; unsupported/missing payloads are explicit.
- Capabilities per scope: properties, actor inventory, graph topology, source geometry, render geometry, image data, hierarchy and visual reconstruction. Each scope is complete, partial, unsupported or unavailable with diagnostics and provenance.
- Object identities, typed property paths/values, references and family-specific data. Preserve serialized versus resolved/inherited values separately; omitted defaults are not automatically zero/false/empty.
- Side states including absent, missing/offline LFS, parse failure, unsupported format and ready document. Partial decoding must never turn unknown items into additions/deletions.
- Large geometry/media as bounded local payload handles, not huge JSON/base64 IPC responses. Restrict access to app-owned captures and validate payload dimensions, lengths and paths.

Match actors/states/nodes by stable serialized GUID where valid. Use qualified object paths or unique names only as explicit conservative fallbacks. Export indices are revision-local references, not stable identities. Distinguish ambiguous matches. Compare references by resolved package/object identity rather than table index; retain array ordering where meaningful and use typed map/set semantics. Separate authored changes from compiled/generated/cache churn with documented, tested rules. Opaque bytes may be reported as changed with an unknown meaning, never summarized as a known semantic change.

### Revision and dependency correctness

Each historical dependency must come from the same selected commit/tree as its root, including material/mesh/default references and external actor packages. Never use the current worktree to fill missing historical content. For staged reviews use the index; for unstaged reviews use the worktree, preserving existing comparison semantics. Compare untracked/deleted dependencies honestly. Capture a manifest consistently, detect index/worktree changes during capture, retry only within a bounded policy and report inconsistent snapshots rather than mixing times.

For maps, discover owning-world relationships on both sides. A commit can change only `__ExternalActors__`/`__ExternalObjects__` files while the `.umap` remains unchanged. Show a grouped map review without losing actual changed-file paths or inventing a changed map blob. Resolve ownership from package metadata and verified relationships, not filename guesses. [Epic documents external actor storage and encoded filenames](https://dev.epicgames.com/documentation/en-us/unreal-engine/one-file-per-actor-in-unreal-engine). Unloaded or unavailable actors must be identified as outside coverage.

Keep metadata extraction independent of expensive preview decoding. Load dependencies on demand, batch path/blob lookups, deduplicate shared dependencies across instances and cap recursion, dependency count, bytes and geometry. Key caches by the full manifest/config/reader versions; a material or external actor change must invalidate the appropriate derived preview even if the root blob is unchanged. Selection cancellation detaches consumers; shared jobs remain usable by other subscribers. CPU extraction runs after releasing repository capture slots. No extraction on camera movement or tab changes when data is cached.

## Delivery checklist

Every unchecked item below requires implementation and evidence. The approved mockup is design evidence only. Record fixture versions/hashes, expected results, browser/runtime checks and limitations per phase in a companion implementation evidence document when work begins.

### Phase 0 — Prove target profiles and freeze acceptance

- [ ] Select real saved fixtures from the user's active UE version (including UE5.8 where relevant): traditional map, World Partition/OFPA map, static mesh, skeletal mesh, StateTree and complex Animation Blueprint. Record actual save versions rather than installation versions.
- [ ] Build explicit before/after fixture pairs with isolated edits: moved/added/deleted actor, external actor-only edit, material slot/build setting, StateTree task/transition/binding and AnimGraph/transition edit. Use a separate test project for newly authored fixtures; do not change production assets for testing.
- [ ] Record editor ground truth including inventory, hierarchy, GUIDs, properties, connections, transforms, units and counts. Private fixture manifests may reference local assets; redistribute only appropriately licensed/sanitized samples.
- [ ] Spike UAssetAPI map/StateTree extraction and CUE4Parse editor-source geometry; assess required custom structs/native tails, package trailers and target-version compatibility.
- [ ] Decide the minimum supported profiles, preview format/provider and license/packaging requirements from measured results. Record failures and fallback paths without blocking supported families indefinitely.

Exit: per-family evidence says which fields and previews can be faithful, which are partial and which require an engine provider. Do not advertise broad UE5 support from one sample.

### Phase 1 — Asset review host and map contents/changes

- [ ] Extend package selection/capture to `.umap` and add a versioned asset document contract alongside existing Blueprint types. Keep current Blueprint callers and behavior working.
- [ ] Add the approved Changes / Contents / Preview navigation, real revision identities, capability footer and binary-details recovery to the existing details surface. Preserve file navigation, fullscreen state, inspector selection and cameras where applicable.
- [ ] Implement traditional-map actor/component inventory, labels/classes, serialized transforms, attachments, mesh/material references and the supported world-settings subset.
- [ ] Compare GUID/path-matched actors and typed properties; distinguish relative/world transforms, units, changed labels and unknown/inherited defaults.
- [ ] Build selectable actor changes and before/after details. Contents supports either side; Preview shows a capability-specific unavailable state until a real preview provider exists.
- [ ] Verify root/merge-parent semantics, renames, added/deleted files, staged/unstaged review, missing LFS, malformed packages and out-of-order selection responses.

Exit: a real Timeline map comparison shows correct actors and exact property edits with truthful coverage; existing Blueprint review still works. This is the first usable release slice.

### Phase 2 — World Partition / external actor review

- [ ] Resolve map ownership and external package identities on both revisions. Group changed external actors under the map, retaining direct file selection and traceable source paths.
- [ ] Enumerate selected revision actor packages using bounded/batched tree/index/worktree queries and cached ownership metadata. Support actor moves between maps, map renames and deleted owners conservatively.
- [ ] Detect external-actor-only edits, additions/deletions, data-layer memberships and supported references without requiring a changed `.umap`.
- [ ] Distinguish changed-actor review from full-world inventory; explicitly label partial inventory, missing dependencies and unresolved ownership.
- [ ] Verify a real OFPA move/property edit with identical root `.umap` bytes; validate actor counts/ownership against Unreal and measure a representative large map.

Exit: external package changes are readable as map changes without mixing revision data or scanning all asset bytes on each click.

### Phase 3 — StateTree contents, changes and hierarchy

- [ ] Decode editor state hierarchy, stable state/task/transition identities, schema, evaluators/global tasks, parameters, enter/transition conditions, targets, task instance data and property bindings for verified profiles.
- [ ] Handle versioned instanced structs/property bags and custom task payloads explicitly; do not substitute compiled runtime state indices for authored identities.
- [ ] Compare state addition/removal/reparenting, task order, transition order/conditions/targets, parameters and binding paths.
- [ ] Add a dedicated hierarchy preview with selection, expand/collapse and linked property details. Keep StateTree presentation distinct from Klee's Blueprint canvas.
- [ ] Verify custom task, linked subtree, changed binding and partial-payload fixtures against editor ground truth; no unsupported field can appear unchanged solely because it was omitted.

Exit: the ST_Guard-style mockup is backed by real states, transitions and inspectable before/after data.

### Phase 4 — AnimGraphs and animation state machines

- [ ] Support animation graph subclasses/schemas, pose pins, native node data, nested state machines, transition-rule graphs, linked graphs/layers and relevant asset references for verified profiles.
- [ ] Reuse existing K2 extraction and semantic comparison; extend graph-family labels/selectors so event graphs, pose graphs and state machines remain individually accessible.
- [ ] Prove Klee's pose-node/wire rendering; add narrowly scoped adapters or a specialized state-machine canvas where generic rendering loses semantics.
- [ ] Compare pose topology, node settings, BlendSpace/sequence references, state/transition changes and rule/default edits separately from layout and generated metadata.
- [ ] Preserve authored graph positions, read-only controls, node selection, inspector, change navigation, camera sync, fullscreen/Escape and accessible list alternatives.
- [ ] Verify nested states, pose rewiring, blend settings, transition rules and custom animation nodes against Unreal; re-run existing Blueprint semantic-change and rendering regressions.

Exit: an actual Animation Blueprint exposes its AnimGraph and state machine, not just its ordinary event graphs. The approved ABP_Guard preview is the visual target.

### Phase 5 — Mesh contents and interactive preview

- [ ] Extract supported metadata: material slots, bounds, source/build settings, collision settings, LOD descriptors, and skeletal hierarchy/skin data where decoded. Unavailable triangle counts stay unavailable.
- [ ] Bundle the chosen geometry provider and renderer; decode source/render LODs with named profiles and verified bulk-data handling. Keep a metadata-only fallback.
- [ ] Implement orbit/zoom/fit, base/selected toggle, wireframe, LOD selection and material/section inspection. Reuse loaded geometry across controls; dispose GPU resources on eviction/unmount.
- [ ] Preserve axes, handedness, centimeters, instance transforms, skeleton/skin weights and material slot assignments. Approximate PBR reconstruction is visibly distinct from original Unreal shader appearance.
- [ ] Compare metadata and proven geometry/section changes. A changed opaque geometry payload is labeled as such; triangle-count equality never establishes unchanged geometry.
- [ ] Verify static and skeletal fixtures, missing textures, unsupported Nanite-only profiles, corrupt payloads, GPU/resource bounds and packaged offline execution.

Exit: real supported meshes show correct geometry and revision-specific materials with accurate coverage and no tab/camera-triggered extraction.

### Phase 6 — Map spatial preview

- [ ] Start with a real schematic spatial preview of decoded actor transforms/bounds, with added/removed/modified markers linked to the change list. Label it schematic, not a rendered level.
- [ ] Add dependency-backed static geometry using the verified mesh provider, shared instancing and deterministic transforms. Load each side's referenced asset revisions; expose omitted actors and missing geometry.
- [ ] Support selecting an actor, framing its location and comparing base/selected positions. Keep a stable camera when toggling revisions or change decorations.
- [ ] Add verified lights/material approximations; report limits for landscapes, foliage, splines, procedural actors, construction-script-generated components, dynamic Blueprint behavior and unsupported bulk data.
- [ ] Verify ordinary and OFPA maps against editor placement/bounds. A lightweight reconstruction must not claim faithful Unreal lighting/shaders or execute Blueprint logic.

Exit: map previews locate real changes and correctly reconstruct supported placement, with explicit omission counts. The mockup's warehouse scene is a layout reference, not reusable asset geometry.

### Phase 7 — Release acceptance and extension points

- [ ] Run focused extraction/semantic comparison, real-Git/LFS, browser and existing Blueprint suites; complete renderer/main typechecks, scoped lint and production build.
- [ ] Verify actual desktop Timeline selection for every supported family, rapid file switching, keyboard/focus, narrow panes, 200% scaling, fullscreen/Escape and persistent selection across view changes.
- [ ] Validate historical dependencies differing from the worktree, staged dependency edits, missing offline LFS, explicit retry and unchanged repository state (HEAD, index and worktree hashes).
- [ ] Measure cold/warm latency, dependency count/bytes, output/IPC sizes, queue responsiveness, cache hit rate and peak memory/GPU usage on small and representative large fixtures. Record target budgets and observed results; tune bounds only with evidence.
- [ ] Verify shipped helpers/native libraries/notices on supported Windows, macOS and Linux packages without developer runtimes or startup downloads. Publish profile-specific support rather than assuming platform parity.
- [ ] Document supported class/save-version/provider combinations, known omissions and recovery. Keep optional engine integration separately scoped.
- [ ] Review matching audit IDs, update only fully verified scopes and run the applicable generators. No acceptance box is checked solely because the mockup looks right.

Exit: all four approved asset families have verified supported profiles and the approved UI is usable in the packaged app. Unsupported files remain inspectable through available metadata/binary details with recovery.

## Audit tracking

Planning does not resolve findings; no audit checkbox is changed by this document. Reports inspected on 2026-10-09 show functional progress 79/85 and UI progress 1/60.

| Finding | Relationship / rule |
| --- | --- |
| LG-014, LG-015, LG-051, LG-052, LG-054 | Preserve existing safe async capture, single reads, bounded output, stale-response guards and binary routing. Reopen only on demonstrated regression. |
| LG-055 | Existing Unreal commandlet integration remains unchecked. Standalone contents/preview support is not completion of this engine-integration finding. |
| UI-059 | File/ref context in PR/merge/asset dialog actions. Timeline implementation alone does not satisfy its broader acceptance. |
| UI-060 | Shared focus/responsive/pending-operation behavior remains partial. Verify relevant new surfaces; do not close the whole finding from one viewer test. |

When implementation begins, update the appropriate finding's note with actual changes, evidence and remaining limitations. Follow `AGENTS.md`: preserve IDs and Undo category, check only fully resolved findings, regenerate `audit/build-report.cjs` / `audit/build-ui-report.cjs` as applicable and report resolved IDs/progress.

## First implementation task

Begin with Phase 0 map fixtures and Phase 1 traditional-map contents/changes. Prove actor identities, transforms and exact historical bytes, then integrate the approved Changes/Contents surface. External actor support follows before declaring World Partition map support. Research geometry in a bounded spike; do not delay the useful contents/change release while attempting full level rendering.

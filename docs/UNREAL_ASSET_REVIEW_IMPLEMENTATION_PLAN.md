# Unreal asset contents, changes and previews

Created: 2026-10-09. Status: shared review host, initial package/property readers and bounded changed-external-actor review and initial authored StateTree review implemented; full asset-type acceptance remains partial. See [implementation evidence](UNREAL_ASSET_REVIEW_IMPLEMENTATION.md).

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
| [ThreeNative asset MCP](https://github.com/jonit-dev/threenative-asset-mcp) | Inspected checkout provides marketplace search/download metadata; it is not the required uncooked Unreal source-geometry decoder | Do not embed for this pipeline. No public license file was found in the checkout; select a separately licensed decoder or isolated Unreal exporter for native geometry. |
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

Every unchecked item below requires further implementation or acceptance evidence; several are partially delivered as recorded in the companion evidence document. The approved mockup is design evidence only. Record fixture versions/hashes, expected results, browser/runtime checks and limitations per phase in a companion implementation evidence document when work begins.

### Phase 0 — Prove target profiles and freeze acceptance

- [ ] Select real saved fixtures from the user's active UE version (including UE5.8 where relevant): traditional map, World Partition/OFPA map, static mesh, skeletal mesh, StateTree and complex Animation Blueprint. Record actual save versions rather than installation versions.
- [ ] Build explicit before/after fixture pairs with isolated edits: moved/added/deleted actor, external actor-only edit, material slot/build setting, StateTree task/transition/binding and AnimGraph/transition edit. Use a separate test project for newly authored fixtures; do not change production assets for testing.
- [ ] Record editor ground truth including inventory, hierarchy, GUIDs, properties, connections, transforms, units and counts. Private fixture manifests may reference local assets; redistribute only appropriately licensed/sanitized samples.
- [ ] Spike UAssetAPI map/StateTree extraction and CUE4Parse editor-source geometry; assess required custom structs/native tails, package trailers and target-version compatibility.
- [ ] Decide the minimum supported profiles, preview format/provider and license/packaging requirements from measured results. Record failures and fallback paths without blocking supported families indefinitely.

Exit: per-family evidence says which fields and previews can be faithful, which are partial and which require an engine provider. Do not advertise broad UE5 support from one sample.

### Phase 1 — Asset review host and map contents/changes

- [x] Extend package selection/capture to `.umap` and add a versioned asset document contract alongside existing Blueprint types. Keep current Blueprint callers and behavior working.
- [ ] Add the approved Changes / Contents / Preview navigation, real revision identities, capability footer and binary-details recovery to the existing details surface. Preserve file navigation, fullscreen state, inspector selection and cameras where applicable.
- [ ] Implement traditional-map actor/component inventory, labels/classes, serialized transforms, attachments, mesh/material references and the supported world-settings subset.
- [ ] Compare GUID/path-matched actors and typed properties; distinguish relative/world transforms, units, changed labels and unknown/inherited defaults.
- [x] Build selectable actor changes and before/after details. Contents supports either side; Preview shows a capability-specific unavailable state until a real preview provider exists.
- [ ] Verify root/merge-parent semantics, renames, added/deleted files, staged/unstaged review, missing LFS, malformed packages and out-of-order selection responses.

Exit: a real Timeline map comparison shows correct actors and exact property edits with truthful coverage; existing Blueprint review still works. This is the first usable release slice.

### Phase 2 — World Partition / external actor review

- [x] Resolve map ownership and external package identities on both revisions. Group changed external actors under the map, retaining direct file selection and traceable source paths.
- [x] Enumerate selected revision actor packages using bounded/batched tree/index/worktree queries and cached ownership metadata. Support actor moves between maps, map renames and deleted owners conservatively.
- [x] Detect external-actor-only edits, additions/deletions, data-layer memberships and supported references without requiring a changed `.umap`.
- [x] Distinguish changed-actor review from full-world inventory; explicitly label partial inventory, missing dependencies and unresolved ownership.
- [ ] Verify a real OFPA move/property edit with identical root `.umap` bytes; validate actor counts/ownership against Unreal and measure a representative large map.

Supported initial profile: conventional Content/__ExternalActors__ storage with saved ActorGuid and PersistentLevel ownership. Ownership fields reuse immutable reader/document caches; Git manifests are rebuilt on demand. The final editor/count/large-map acceptance item remains open. See implementation evidence for limits and fixture results.

Exit: external package changes are readable as map changes without mixing revision data or scanning all asset bytes on each click.

### Phase 3 — StateTree contents, changes and hierarchy

- [ ] Decode editor state hierarchy, stable state/task/transition identities, schema, evaluators/global tasks, parameters, enter/transition conditions, targets, task instance data and property bindings for verified profiles.
- [ ] Handle versioned instanced structs/property bags and custom task payloads explicitly; do not substitute compiled runtime state indices for authored identities.
- [ ] Compare state addition/removal/reparenting, task order, transition order/conditions/targets, parameters and binding paths.
- [x] Add a dedicated hierarchy preview with selection, expand/collapse and linked property details. Keep StateTree presentation distinct from Klee's Blueprint canvas.
- [ ] Verify custom task, linked subtree, changed binding and partial-payload fixtures against editor ground truth; no unsupported field can appear unchanged solely because it was omitted.

Follow-up 2026-10-10: binding endpoint names/matching and same-revision object navigation are implemented. Duplicate/ambiguous endpoints remain incomplete; type validation, custom property bags and linked assets remain outside coverage.

Initial supported profile: the local UE 5.8.0 ST_Shooter editor package preserves array entries and instanced struct types, exposes states/tasks/conditions/transitions/global tasks/bindings through the shared inspector, and compares GUID-matched authored task edits/order. Opaque property bags/custom payloads and linked-subtree/editor acceptance keep the broader items unchecked. Reader 10 invalidates earlier lossy StateTree cache documents.

Follow-up 2026-10-10: structured saved LinkedSubtree GUID references now support local target inspection and a focused child/task hierarchy with Show whole tree recovery. Only explicit GotoState targets with unique IDs/paths in the captured package resolve; ambiguous, raw, absent and non-direct links remain explicit. Unique-only child traversal guards cycles/collapse and caps the preview at 1000 states. Indexes and derivations are memoized, without new reads. All 17 focused shared/StateTree/inventory checks pass. Navigation uses controlled saved-link fixtures; actual linked-subtree/editor/parameter-override and external expansion acceptance remain unchecked.

Exit: the ST_Guard-style mockup is backed by real states, transitions and inspectable before/after data.

### Phase 4 — AnimGraphs and animation state machines

- [ ] Support animation graph subclasses/schemas, pose pins, native node data, nested state machines, transition-rule graphs, linked graphs/layers and relevant asset references for verified profiles.
- [x] Reuse existing K2 extraction and semantic comparison; extend graph-family labels/selectors so event graphs, pose graphs and state machines remain individually accessible.
- [ ] Prove Klee's pose-node/wire rendering; add narrowly scoped adapters or a specialized state-machine canvas where generic rendering loses semantics.
- [ ] Compare pose topology, node settings, BlendSpace/sequence references, state/transition changes and rule/default edits separately from layout and generated metadata.
- [ ] Preserve authored graph positions, read-only controls, node selection, inspector, change navigation, camera sync, fullscreen/Escape and accessible list alternatives.
- [ ] Verify nested states, pose rewiring, blend settings, transition rules and custom animation nodes against Unreal; re-run existing Blueprint semantic-change and rendering regressions.

Exit: an actual Animation Blueprint exposes its AnimGraph and state machine, not just its ordinary event graphs. The approved ABP_Guard preview is the visual target.

Follow-up 2026-10-10: saved state-machine summaries now show authored state and alias names, reciprocal transition endpoints, saved crossfade/blend/priority/automatic-rule settings and exact captured graph links. Alias members resolve only within that side; pose/rule navigation and bounded Back navigation reuse existing Klee controls without fetching another package. Missing native pose graphs, ambiguous endpoints and omitted defaults stay explicit. Real ABP_Unarmed and browser transition-edit/navigation checks pass; broader native pose and Unreal editor acceptance remain unchecked.

### Phase 5 — Mesh contents and interactive preview

- [ ] Extract supported metadata: material slots, bounds, source/build settings, collision settings, LOD descriptors, and skeletal hierarchy/skin data where decoded. Unavailable triangle counts stay unavailable.
- [ ] Bundle the chosen geometry provider and renderer; decode source/render LODs with named profiles and verified bulk-data handling. Keep a metadata-only fallback.
- [ ] Implement orbit/zoom/fit, base/selected toggle, wireframe, LOD selection and material/section inspection. Reuse loaded geometry across controls; dispose GPU resources on eviction/unmount.
- [ ] Preserve axes, handedness, centimeters, instance transforms, skeleton/skin weights and material slot assignments. Approximate PBR reconstruction is visibly distinct from original Unreal shader appearance.
- [ ] Compare metadata and proven geometry/section changes. A changed opaque geometry payload is labeled as such; triangle-count equality never establishes unchanged geometry.
- [ ] Verify static and skeletal fixtures, missing textures, unsupported Nanite-only profiles, corrupt payloads, GPU/resource bounds and packaged offline execution.

Follow-up 2026-10-10: saved BoxElems now render alongside ConvexElems using explicit centers, degree rotators and full dimensions, including planar zero-thickness boxes. Missing/invalid fields remain omitted and unsupported saved collision shape arrays report omissions. Preview tessellation counts are separate from render-mesh topology. Paired summaries show decoded collision shapes/counts/extents at both captured revisions with shared memoized geometry and no new reads. All 24 focused checks pass, including real SM_ChamferCube/SM_Plane source preservation, rotated/invalid/limited profiles and browser comparison/control checks. The broader source/render mesh, skin/LOD/material and engine-ground-truth items stay unchecked.

Exit: real supported meshes show correct geometry and revision-specific materials with accurate coverage and no tab/camera-triggered extraction.

### Phase 6 — Map spatial preview

- [ ] Start with a real schematic spatial preview of decoded actor transforms/bounds, with added/removed/modified markers linked to the change list. Label it schematic, not a rendered level.
- [ ] Add dependency-backed static geometry using the verified mesh provider, shared instancing and deterministic transforms. Load each side's referenced asset revisions; expose omitted actors and missing geometry.
- [ ] Support selecting an actor, framing its location and comparing base/selected positions. Keep a stable camera when toggling revisions or change decorations.
- [ ] Add verified lights/material approximations; report limits for landscapes, foliage, splines, procedural actors, construction-script-generated components, dynamic Blueprint behavior and unsupported bulk data.
- [ ] Verify ordinary and OFPA maps against editor placement/bounds. A lightweight reconstruction must not claim faithful Unreal lighting/shaders or execute Blueprint logic.

Follow-up 2026-10-10: schematic markers are dots with hover/focus names; drag/scroll/keyboard camera controls, Fit, Focus selected, coincident-object selection and a shared camera across sides/tabs are implemented. Browser checks cover the interaction and narrow panes. Full actor/world transform composition, geometry/bounds and editor placement acceptance keep the broader checklist items unchecked.

Follow-up 2026-10-10: XY top, XZ front and YZ side projections now expose saved height differences. Each plane requires both finite saved coordinates; package-object coverage counts and empty-plane controls preserve recovery. Projection/camera survive side and tab changes; changing planes refits bounded shared revision bounds. Guides and tooltips name the chosen axes. Twelve focused real-map/browser/shared-host checks pass; no new extraction or dependency reads occur. World transform/bounds/geometry and engine placement acceptance remain unchecked.

Exit: map previews locate real changes and correctly reconstruct supported placement, with explicit omission counts. The mockup's warehouse scene is a layout reference, not reusable asset geometry.

### Phase 7 — Release acceptance and extension points

- [ ] Run focused extraction/semantic comparison, real-Git/LFS, browser and existing Blueprint suites; complete renderer/main typechecks, scoped lint and production build.
- [ ] Verify actual desktop Timeline selection for every supported family, rapid file switching, keyboard/focus, narrow panes, 200% scaling, fullscreen/Escape and persistent selection across view changes.
- [ ] Validate historical dependencies differing from the worktree, staged dependency edits, missing offline LFS, explicit retry and unchanged repository state (HEAD, index and worktree hashes).
- [ ] Measure cold/warm latency, dependency count/bytes, output/IPC sizes, queue responsiveness, cache hit rate and peak memory/GPU usage on small and representative large fixtures. Record target budgets and observed results; tune bounds only with evidence.
- [ ] Verify shipped helpers/native libraries/notices on supported Windows, macOS and Linux packages without developer runtimes or startup downloads. Publish profile-specific support rather than assuming platform parity.
- [x] Document supported class/save-version/provider combinations, known omissions and recovery. Keep optional engine integration separately scoped.
- [x] Review matching audit IDs, update only fully verified scopes and run the applicable generators. No acceptance box is checked solely because the mockup looks right.

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

## Reader 11 follow-up - 2026-10-10

- [x] Preserve repeated saved array entries for World, StaticMesh and SkeletalMesh inventories, with the same raw-field handling and bounded revision capture.
- [x] Identify event/pose/state-machine/transition graph families from supported schemas in the existing graph selector; retain incomplete native-node warnings even when comparison is unavailable.
- [x] Render verified saved convex collision vertices/indices/transforms with orbit, zoom, fit, wireframe, selection and per-side collision counts/extents. Use one camera and union fit bounds across revisions; controls require no new reads.
- [x] Show optional base-to-selected guides for uniquely matched saved map XY edits. Label these component-relative values, not actor world displacement.

This completes bounded additions within phases 1, 4, 5 and 6. It does not complete the full mesh/source-geometry provider or composed map transforms. Phase 2 editor/large-map acceptance and phase 3 custom payload/property-bag support remain as listed above.

## Reader 12 follow-up - 2026-10-10

- [x] Add actor-oriented map contents from explicit saved level membership/verified external actors, labels, root links and bounded owned-export groups. Keep All objects for unassigned/incomplete exports.
- [x] Use actor labels in component dot names/search without inventing world positions.
- [x] Add mesh metadata summaries and selectable native root fallbacks with unavailable counts for unsupported geometry.
- [x] Add typed hard-reference metadata and shared inspector navigation, retaining captured-side identities and commit provenance separate from blob capture. Keep arbitrary strings, plugin mounts, unknown classes and unresolved objects outside navigation.
- [x] Preserve external actor/non-graph arrays and retain derived authored task references; expose structured soft values without treating them as integer indexes.

The skeletal fixture remains a verified opaque fallback. Typed linked-asset navigation is not linked-StateTree expansion, custom property-bag decoding or dependency-backed level reconstruction. Native pose payloads, source/render geometry, full skeletal metadata and composed world transforms remain open.

## Next implementation task

The shared host, exact revision capture, map actor inventory/projections, bounded changed external-actor capture, authored StateTree hierarchy/bindings/local linked-subtree navigation, animation graph families/state-machine navigation, mesh metadata, selected PhysicsAsset body inspection and saved box/sphere/capsule/convex collision previews are implemented within their documented profiles. These are partial phase deliveries, not completion of all six phases.

Remaining work, in dependency order:

1. **Phases 1–2:** verify the installed/packaged reader and PR/merge flows; obtain Unreal Editor ground truth and large-map measurements for external actors. Full World Partition inventory remains outside changed-package capture.
2. **Phase 3:** decode native property bags/custom payloads faithfully; verify local linked-subtree links against a real authored editor fixture, then evaluate parameter overrides and revision-pinned external subtree expansion.
3. **Phase 4:** reader 14 now decodes the real ABP_Unarmed pose graph and reciprocal wires; verify additional native/custom-node profiles and complex pose/state-machine semantics against Unreal Editor results.
4. **Phase 5:** implement and validate a licensed uncooked source/render-geometry decoder or isolated Unreal exporter, skeletal skin/LOD data and additional saved collision profiles. The existing preview covers explicit boxes, spheres, rotator/quaternion-based capsules and convex arrays. The cloned ThreeNative checkout has no license file and is not embedded.
5. **Phase 6:** the explicit saved attachment-chain subset is implemented; resolve inherited defaults, socket/bone and cross-package placement with verified profiles, then add revision-pinned geometry dependencies. Relative and saved-attachment XY/XZ/YZ dots remain schematics.
6. **Acceptance across phases:** packaged desktop, platform compatibility, editor fidelity and measured large-asset performance remain required; browser/build checks cover only the reported slices.

### Sphere collision follow-up — 2026-10-10

- Explicit saved `SphereElems` center/radius now produces a bounded faceted preview through the same CPU/SVG mesh viewer and revision summary. Missing/invalid fields are omitted rather than filled from defaults.
- Each sphere uses 114 preview vertices and 224 preview triangles; generated faces are clearly distinguished from native render topology. All shape profiles share the existing 64-shape/20,000-vertex/10,000-triangle budgets.
- The real UE 5.8.3 `SM_CreatureCapsule` fixture contains sphere collision: saved radius 50.000003814697266 and saved center are preserved. Source bytes remain unchanged; the filename is not used to infer capsule support.
- All 17 focused mesh/inventory checks passed (the real map check was run separately with its fixture enabled), including closed topology, malformed/overflow values, bounds/budgets and shared browser camera, wireframe, selection, revision extents, narrow layout and one capture. Renderer typecheck, scoped lint and production build passed. Capsules, tapered capsules, level sets, native render/source geometry and packaged/editor acceptance remain open.

### PhysicsAsset and capsule follow-up — 2026-10-10

- The shared host now recognizes the captured `/Script/Engine.PhysicsAsset` class for collision/metadata presentation without changing the reader contract or cached documents. Contents includes saved body/bone identities, body arrays, constraints and preview mesh references when decoded.
- A themed, keyboard-accessible body selector previews one exact-path-matched body across revisions. Body choice survives side/tab changes; choosing another body fits its collision. Missing/duplicate body paths do not silently select geometry from another body. The selector exposes at most 1,000 entries; full inventory remains in All objects.
- Skeletal body collision is explicitly bone-local. It is excluded from ordinary mesh collision aggregation and enabled only for the selected PhysicsAsset body. Bone transforms, skeleton assembly, constraints and simulation are not reconstructed.
- Explicit `SphylElems` center, degree rotation, radius and cylinder length produce faceted capsules (130 preview vertices / 256 triangles; zero cylinder length reuses sphere topology). The total axial length includes both radius caps, matching [Epic FKSphylElem documentation](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/FKSphylElem). Missing fields, legacy orientation-only shapes, invalid dimensions and overflow remain omitted; tapered capsules and level sets are still unsupported.
- Real `PA_Mannequin` spine_03 body readback preserves saved cylinder length/radius and source bytes. Focused checks cover topology, rotations, shared limits, ordinary-mesh exclusion, selector recovery, removed-body retention, side/tab persistence, inspector/metadata, theme and narrow layout. Native render/skin geometry, editor skeletal placement and packaged acceptance remain open.

Verification for the PhysicsAsset/capsule follow-up: all 25 focused mesh/inventory/shared-review checks passed with every real fixture enabled; renderer typecheck, scoped lint, production build and diff whitespace checks passed. Visual inspection confirmed the themed body selector. Installed/packaged desktop and Unreal Editor fidelity remain pending.

### Legacy quaternion collision follow-up — 2026-10-10

- Saved box and capsule rotation now accepts either explicit degree `Rotation` or explicit quaternion `Orientation`. Both fields together remain ambiguous and are omitted. Missing/nonfinite quaternion components and norms outside 0.999–1.001 are rejected; accepted float roundoff is normalized through the same helper used by convex transforms. No absent identity/default orientation is supplied.
- The real UE 4.9.2 `SK_Eel_PhysicsAsset` has 27 bone-local quaternion capsules. Each decodes individually with saved center/radius/cylinder length; pole positions agree with an independently calculated rotated Z axis and source bytes remain unchanged. Legacy boxes are covered by controlled fixtures; a real legacy-box/editor fixture is still pending.
- The shared PhysicsAsset browser path covers both legacy and current bodies, including revision extents, orbit/zoom/wireframe, inspector/metadata, removed-body retention, tabs and narrow layout without another capture. A selected body beyond the 1,000-entry selector limit retains its own option; duplicate paths remain unavailable.
- This extends phase 5 supported saved collision profiles. Tapered capsules, level sets, native render/source geometry, skeleton placement, StateTree native bags, skipped animation pose data, composed world transforms and packaged/editor acceptance remain unfinished. [Epic quaternion rotation API](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Core/VectorQuaternionRotateVector) defines vector rotation using a unit quaternion; legacy field presence is evidenced by the saved fixture, not inferred from its filename.

Verification for this follow-up: all 29 focused mesh/inventory/shared-viewer checks passed with all real fixtures enabled; renderer typecheck, scoped lint, production build and diff whitespace checks passed. Visual inspection confirmed the themed quaternion capsule preview.


### Actor-root map schematic follow-up — 2026-10-10

The shared map preview now defaults to Actor roots when either captured side has proven saved actor membership. One dot represents each uniquely resolved root owned by its actor through the saved outer chain; actor names replace component labels in this view. Missing/duplicate root references, foreign ownership and incomplete coordinates are excluded with separate coverage counts. All positioned exports recovers the component-level view. Maps without actor membership retain that view and do not offer a misleading root selector.

The host preserves scope, projection and camera across sides/tabs; changing scope refits using the bounded geometry of both captured revisions. Root-relative values remain explicitly schematic: attachments and world placement are not composed. Markers represent root-component changes, not all actor property changes. Position guides use the active scope so child/unassigned edits cannot appear as actor-root movements. Per-revision actor inventories and guide membership sets are memoized; interaction causes no new reads and existing per-side 1,000-dot bounds remain intact.

Read-only Overview evidence: 51 saved actors, 50 unique owned roots, 47 roots with complete saved XY/XZ/YZ coordinates; source bytes remain unchanged. Thirteen focused map/inventory/shared-review checks passed, including ownership ambiguity, real coverage, root versus child guides, overlap selection, hover/inspector, pan/zoom, scope/projection/ref retention, narrow layout and one capture. Renderer typecheck, scoped lint, production build and diff whitespace checks passed. Visual inspection confirmed the actor-root schematic. Native geometry dependencies, composed world transforms and packaged/Unreal Editor placement acceptance remain open.


### Animation sequence/montage review follow-up — 2026-10-10

The existing `animation-sequence` reader family now has focused saved metadata and a reusable timing schematic in the shared host. Contents summarizes saved duration, skeleton references, root-motion flags, notify/slot/section arrays and import/compression settings, with All objects recovery and native-byte warnings. The preview uses the same captured documents and inspector/reference navigation; no new decoder, IPC request or dependency scan is introduced.

The bounded timing model requires one unique sequence/montage root. Segment ranges derive from explicit finite StartPos, AnimStartTime, AnimEndTime, nonzero AnimPlayRate and positive integer LoopingCount. Negative play rates retain the saved range duration via their magnitude. This is a formula-based schematic of saved trim/rate/loop fields, not Unreal playback: dependency/global rate scales, clamping, linked adjustment and section control flow are unresolved. Section/notify anchors require both LinkMethod and CachedLinkMethod explicitly Absolute plus finite nonnegative LinkValue; other/missing links remain listed with unresolved timing. Notify duration is shown only when explicitly finite/nonnegative; runtime trigger offsets and notify execution are not evaluated. Raw tagged timing fields are excluded. Missing SequenceLength stays unavailable rather than derived from a montage or import frame rate.

Sections, segments and notifies share a 1,000-entry preview budget, with bounded array traversal and visible omitted counts. Both sides share one displayed time extent. Host state retains selected saved field paths across sides/tabs and resets for a new request; index paths are field locations, not inferred stable event IDs. Selected rows expose captured timing fields (12,000-character view cap) and select the existing package inspector. Metadata renders up to 250 root exports; the complete inventory remains in All objects.

Real UE 5.8.3 evidence: `AM_WashGun_Att_Swap` has a Default absolute section at 0, two saved segment ranges 0–0.65 and 0.65–1.3 seconds, a saved SequenceLength near 1.3, and typed AnimSequence references. `MF_MP_Unarmed_Walk_Fwd` has explicit SequenceLength 1.5; `AS_WaterGun_Retract` has no supported tagged duration and stays unavailable. All source bytes remain unchanged. Notify rendering is verified with controlled saved-field fixtures; a real notify/linked-time editor fixture remains pending.

All 12 focused animation/timing/shared review checks passed with real fixtures enabled, including invalid/opaque/overflow fields, shared budgets, real readback, existing state/rule graph navigation, saved-entry selection, side/tab persistence, same-scale bars, revision-pinned skeleton navigation, narrow layout and one capture. Renderer typecheck, scoped lint, production build and diff whitespace checks passed; browser visual inspection was performed. Native pose/curve decoding, custom nodes, StateTree property bags, geometry/world placement and packaged/Unreal Editor fidelity acceptance remain open.

Field semantics were checked against [Epic FAnimSegment documentation](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Engine/FAnimSegment) and [FAnimNotifyEvent documentation](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/FAnimNotifyEvent?lang=en-US). These sources describe fields and runtime APIs; the displayed ranges are explicitly saved-value schematics rather than an engine evaluation.


### Map search and bounded navigation follow-up — 2026-10-10

The shared map preview now exposes search outside the overlapping-object list. Search covers captured actor labels, object names, class paths, object paths, source packages and outer paths before applying the 1,000-dot rendering limit. This makes late captured exports discoverable without expanding the DOM budget. A matching selected position replaces the last bounded result when necessary; selection cannot bypass the active filters. Counts distinguish displayed, matching, total positioned and omitted entries. This searches only captured data, not the full world or unreviewed external packages.

Changed dots only includes captured added/removed/modified/unknown component changes on the selected revision. It remains disabled when comparison is unavailable or the viewer is single-sided; actor-root markers continue to describe root-component changes. Fit results centers the displayed results using the existing bounded camera zoom. Search and changed-only controls persist across tabs, revision sides, scopes and projections, and reset with a new capture. Default revision bounds remain shared; filtering never changes them or triggers extraction. Movement guides are filtered after matching, stay bounded to displayed dots, and do not imply world-space movement.

Acceptance: all 14 focused map/inventory/shared tests passed with real UE map and animation fixtures enabled. Controlled browser coverage uses 1,105 positioned exports, finds an export beyond the original dot budget, fits its center, preserves filters across tabs/sides, reports empty matches and verifies changed-only dots. Existing pan/zoom/hover/overlap selection, root scope, projection, 480px layout and one-capture checks pass. The real map retains 51 actors, 50 owned roots and 47 explicit positions in each projection; read-only source preservation passes. Renderer typecheck, scoped lint, production build, diff whitespace and screenshot inspection pass. These checks do not establish packaged desktop acceptance, Unreal Editor fidelity or representative large-world performance. Native payload decoding and composed world placement remain open.


### Indexed tagged fields and BlendSpace review follow-up — 2026-10-10

Reader 13 fixes a real inventory failure: a tagged export with repeated top-level names was treated as a dynamic array and could not be cast to a property dictionary. The real OGS BlendSpace has BlendParameters at explicit saved indexes 0 and 1; the old reader lost all tagged fields. Static indexed fields now use Name[index] keys (including sparse indexes), while ordinary index-zero scalar fields and dynamic array entry order retain their existing shape. Empty tagged exports produce an empty object. Duplicate/negative static indexes retain all saved values under the field name, mark the field opaque and add an ambiguity diagnostic; unrelated fields remain available. Typed reference paths use matching static indexes and skip ambiguous groups. Raw static fields use the same opaque keys. Group counts are built once rather than rescanning the field list per raw property. Graph-root property extraction is preserved. Main/helper and extractor/cache version markers are both 13, invalidating older failed inventories; extraction queues, document budgets, exact revisions and authenticated LFS remain unchanged.

The shared viewer recognizes serialized BlendSpace/BlendSpace1D and AimOffset class names and reuses Animation metadata, All objects, Changes and the saved-object inspector. Its authored sample preview renders only explicit finite X (1D) or X/Y (2D) coordinates. Sample positions are selected through dots or an accessible bounded list; coincident samples stay individually selectable. Selected fields and animation links use the existing captured inspector/reference navigation, with exact base commit refs. Selected sample field paths persist across revision sides and tabs and reset with a new capture; indexes are field locations, not proven stable sample identities. Both revisions share observed bounds, supplemented only by explicitly saved axis endpoints. Missing Min/Max fields remain unavailable; displayed extents are separately labeled. No engine defaults, pose blending, triangulation, wrap-input behavior, retargeting or playback are evaluated.

Models/list/dots are bounded to 1,000 saved samples per side, with explicit omitted/incomplete counts; selected field text is capped at 12,000 characters and the full captured data remains in Contents. There is no dependency scan, new IPC capture or GPU resource lifecycle. Real read-only evidence: UE 5.8.3 OGS BS_Idle_Walk_Run decodes 27 samples, explicit Direction [-180,180], Speed Max 600 with missing Min, and typed animation links. UE 5.0.3 BS_MM_WalkRun decodes 3 1D samples with explicit Speed Max 500 and missing Min. Both source byte arrays remain unchanged. AimOffset routing is class-based; real AimOffset/editor fixtures remain pending.

Acceptance: 73 distinct focused checks pass across timing/BlendSpace/Blueprint, map/inventory, mesh/PhysicsAsset, StateTree and external-actor suites. The initial cross-family run skipped its optional real OFPA case; it subsequently passed separately with both local fixtures enabled. Native reader checks cover static/sparse indexes, empty exports and retained ambiguous values alongside existing localized-text/cast/pin-type checks. Browser checks verify dot/list selection, common scales, revision-pinned animation navigation, tab/side persistence, one capture and 480px layout. Renderer/main TypeScript checks, scoped lint, production renderer build, helper build, diff whitespace and visual inspection pass. Packaged desktop, Unreal Editor fidelity, native poses/curves/property bags, render/skin/LOD geometry and composed world placement remain open; no broad audit finding is closed.

Field semantics are checked against [Epic FBlendSample documentation](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/FBlendSample), [FBlendParameter documentation](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/FBlendParameter), and the [documented SampleValue X/Y/Z axis mapping](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/BlendSample?application_version=5.6). The displayed diagram is captured sample data, not engine pose evaluation.


## Reader 14 and saved attachment completion pass — 2026-10-10

- [x] UAR-N14: Decode version-gated editor localization developer notes in tagged FText fields. A build-only, SHA-256-verified source overlay preserves the clean pinned UAssetAPI checkout. Both helper and native tests import the overlay; shipped notices identify it. Editor/cooked boundaries and truncated text are covered separately from pin text.
- [x] UAR-N14-R: Recover independent modern tagged AnimGraph fields only within declared export/property bounds. Unsupported struct arrays remain named opaque fields and make nodes/graphs incomplete; other failures preserve the original raw export. Property-type nodes, export bytes and field counts are bounded. Unversioned, unknown serialization-control and invalid profiles are rejected. Native tests verify following fields, extras and unchanged raw bytes.
- [x] UAR-POSE14: Real ABP_Unarmed AnimGraph now has eight decoded nodes and 17 pins with no graph diagnostics. Tests verify reciprocal endpoints, saved cache setting changes, removed pose wires, Klee wire rendering and graph/rule navigation with one immutable capture. This does not establish correctness for every custom node or full engine playback.
- [x] UAR-MAP-ATT: Add Relative positions / Saved attachments controls to the reusable map preview. Compose only explicit finite location/rotator/positive-uniform-scale chains ending at a verified saved actor root, with explicit nonabsolute flags and no socket. Missing/ambiguous/cross-package parents, cycles/depth limits, inherited defaults, nonuniform scale and nonfinite results remain unresolved with reason counts. Both sides share bounds; mode/camera/selection use existing host state without new IPC. Direct component change markers are labeled; relative movement guides are suppressed in composed mode.
- [x] UAR-WIN14: Build and execute the self-contained Windows helper on real animation, map, StateTree, static mesh, BlendSpace and montage files. Verify reader 14, unchanged source hashes and bundled license notices. This proves the published helper executable, not an installed Electron desktop release or macOS/Linux parity.

Verification: 92 cross-family regression checks passed with every optional fixture in that run enabled, including real Git/LFS/OFPA and browser interaction cases. Native checks cover five pin-text, eight cast/pin, three pin-type, three static-index, five compiled tagged-text and four tagged-recovery cases. Renderer/main TypeScript, scoped lint, production renderer and helper publish checks pass. Existing production bundle-size/Browserslist/CJS warnings remain. Browser map attachment tests cover a complete controlled chain, unresolved cases, mode persistence and 480px layout; real Overview positions still omit required transform defaults and are deliberately not promoted to reconstructed world coordinates.

### Remaining implementation gates

The six broad phases remain partial. Native static/skeletal render geometry, skinning and LOD selection; StateTree instanced property-bag values/custom runtime payloads; inherited/socket/cross-package world placement; and revision-pinned geometry dependency rendering still require additional decoder implementation. The inspected CUE4Parse static-mesh reader initializes modern render data in its cooked branch, and its FInstancedPropertyBag value payload remains TODO/skipped. The cloned ThreeNative repository supplies asset marketplace tools, not the needed source-asset decoder. Simply bundling those repositories would not implement the required uncooked formats. A licensed native decoder or optional isolated Unreal exporter must prove these formats and exact dependency snapshots before those checkboxes can close.

Editor ground truth, representative large-asset measurements, actual packaged desktop Timeline/PR/merge workflows and cross-platform packages remain acceptance work. LG-055, UI-059 and UI-060 remain unchecked; progress stays 79/85 functional and 1/60 UI. No full-phase completion is claimed.

## Native source mesh provider — 2026-10-11

- [x] UAR-NATIVE-1: Add an optional installed-Unreal provider for uncooked UE5 StaticMesh and SkeletalMesh source geometry. The shared Preview tab offers Preview source mesh with Unreal and Saved collision; source LOD selection, orbit/zoom/fit, wireframe, object inspection and paired bounds reuse the existing renderer. Missing-side LODs stay unavailable. The initial selection uses the first readable LOD, while all inspected LODs remain selectable with omission reasons.
- [x] UAR-NATIVE-GIT: Export only captured package/companion bytes after releasing the repository read slot. A generated temporary project preserves the selected package mount and serialized mesh object name, including renamed repository paths. No repository project configuration, project plugins, startup scripts or working dependencies enter the engine. Historical export succeeds even when the current working file is deliberately invalid. Verify both isolated input copies after engine exit and discard any mutated result.
- [x] UAR-NATIVE-BOUNDS: Limit native input plus companion to 64 MB, inspect at most eight source LODs, and share 20,000 vertices / 10,000 triangles across those LODs. Validate finite coordinates, dense IDs, topology, declared counts, engine version and a 4 MB JSON boundary before transfer. One engine process runs at a time with four cancellable waiters, a 120-second process deadline, bounded diagnostic output and eight completed geometry cache entries. Streaming hashes keep queued jobs from retaining package buffers. The compact document protocol retains geometry separately from cached metadata; failed exports preserve inventory and collision recovery.

Real read-only evidence: SM_Cube exports through installed UE 5.6.1 with eight source vertices and twelve triangles; SK_WashGun exports through UE 5.8.3 with 218 source vertices and 378 triangles. Both are captured from immutable Git commits under a renamed filename, with different invalid working bytes. Original fixture bytes, working replacements and repository snapshots remain unchanged. Native output is 555 bytes and 17,313 bytes respectively in this run. These are small-fixture measurements, not representative large-world benchmarks. The saved UE 5.7 Manny package correctly reports a missing matching engine on this machine; the provider never substitutes another minor engine version.

The embedded script calls documented [GeometryScript asset extraction APIs](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/GeometryScript_AssetUtils?application_version=5.6) through Epic's [Python commandlet entry point](https://dev.epicgames.com/documentation/en-us/unreal-engine/scripting-the-unreal-editor-using-python). No Unreal executable, proprietary engine source or new third-party decoder is bundled. The installed matching engine supplies the provider. Bounded source geometry uses the existing JSON/CPU renderer seam; larger geometry handles and GPU rendering remain future work rather than bypassing these caps.

Remaining phase gates: source geometry support now has a real provider, but generated render LODs/Nanite, UV/material/section rendering, skin weights/skeleton overlays and animation playback are unfinished. Native StateTree property-bag values, inherited/socket/cross-package world placement and revision-pinned geometry/material dependency snapshots remain unfinished. Plugin mounts, external bulk files, additional engine profiles, representative large assets and installed/packaged desktop/macOS/Linux acceptance remain unverified or unsupported. The broad six-phase checkboxes and LG-055/UI-059/UI-060 stay unchecked.

Verification for this pass: 101 distinct cross-family checks passed across the shared viewers, native provider, real Git/LFS/OFPA and browser suites, with their optional fixtures enabled when run. The five initial integration-test failures were corrected by adding the native shutdown mock and scoping collision-camera locators; all five reran successfully. Native boundary and queue tests, compact document hydration, lower-LOD fallback, side/tab persistence and 480px layout pass. Renderer/main TypeScript, scoped lint, production build and screenshot inspection pass. Existing production CJS, Browserslist and bundle-size warnings remain. Functional/UI audit progress remains 79/85 and 1/60.

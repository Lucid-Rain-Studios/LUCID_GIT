# Unreal asset review implementation

Implemented 2026-10-09 against the approved HTML concept. The reusable review host is available through the existing Timeline preview, Content Browser preview, revision context actions, and PR review/merge-choice workspace. Generic file metadata/history remains accessible through Details or Binary details. Existing merge choices continue to select whole revisions; reviewing never edits an Unreal package.

## Delivered

- Changes / Contents / Preview, exact revision labels, asset navigation, selectable before/after saved values, searchable inventories, side selection, retry, fullscreen/Escape, focus restoration, and coverage explanations.
- `.uasset` and `.umap` capture through the existing revision service, including its `.uexp`, Git/LFS, cancellation, queue, cache, and output limits. No separate scanning service or parallel IPC path.
- Reader version 9 adds serialized export names/classes/outer paths, tagged properties, GUID-or-path matching, level actor references, native-byte fingerprints, raw-field labels and diagnostics. Raw tagged fields cannot become decoded property edits. Missing or unreadable sides cannot become additions/removals.
- Maps: package contents and property changes, plus a selectable XY schematic of explicitly saved component-relative positions. Coordinates are centimeters; attachment/world transforms and omitted defaults are unresolved. At most 1,000 positions are drawn, with revision-side change markers and linked before/after inspection.
- StateTrees: exported state objects and saved properties, plus a hierarchy from decoded explicit Children references. Numeric-key saved arrays and wrapped state names are supported. Tasks/transitions/bindings remain inspectable properties, not a complete execution visualization.
- Animation Blueprints: explicit animation graph/state-machine/transition graph classes and schemas admitted to the existing graph reader. Pins/native tails retain strict parsing and partial diagnostics. Existing Klee graph controls and semantic comparison are reused, with no second package request from the nested canvas. Graph state stays mounted across tabs.
- Meshes and other asset classes: actual package contents/properties and explicit opaque-payload differences. Unsupported visuals show a useful explanation and Contents remains available.

Inventories initially render 250 rows, with explicit additional pages. Existing service ceilings remain 20,000 objects/nodes, 256 MB inputs/disk cache, two active helpers/eight queued jobs, 25 seconds per helper, 32 MB helper output, and eight retained documents. Geometry/GPU resources are not allocated.

## Source fixture evidence

These private assets were read without changing their files; they are not copied into the repository. Actual editor ground-truth comparison remains the user's acceptance step. Subprocess timing below is a single local observation, not a performance guarantee.

| Local fixture under LRS_OGS Content | Observed result | SHA-256 |
| --- | --- | --- |
| OceanFloor/Maps/Overview.umap | 176 objects; actor references and wrapped relative positions; approximately 129 KB output / 336 ms | `9731e966c85117a732669c0aaaaaedb7206d6becf60d77ae3b9c982d8c90bcc9` |
| LevelPrototyping/Meshes/SM_Cube.uasset | StaticMesh; seven objects; property inventory; approximately 4.5 KB / 276 ms | `4680317a8c87f983e077f6c0a6b93ffaa0ba4dbddbc810960d4553e6ad380a89` |
| FirstPerson/Anims/ABP_FP_Copy.uasset | Recorded UE 5.6.0; 18 objects; complete AnimGraph (three nodes) and EventGraph (two nodes); approximately 27 KB / 299 ms | `a9d36cac5bb30f5a5ecdb175dc4fcbd50d8ae74405ad57802436fbedbab02455` |

The bundled UAssetAPI editor Material, SoundClass and Blueprint fixtures validate serialized-class routing independent of filenames. The cooked/unversioned Entry/OpenWorld map fixtures require a configured version/mappings and remain unavailable rather than being guessed. A package's inferred serialization profile is not presented as its recorded save version.

## Verification and remaining work

Focused tests cover exact revision captures, renames/deletions, Git/LFS read-only behavior, cache invalidation, bounded queues, generic property comparison, ambiguous identities, unresolved defaults, raw fields, source-map/AnimGraph extraction, browser inspectors, schematic selection, synthetic StateTree hierarchy, fullscreen/Escape, narrow windows, context actions, Content Browser, and unchanged PR whole-file resolution. Existing Blueprint semantic/pin/canvas checks remain in the suite. All 39 selected checks passed; the final marker/retry changes passed a 25-check rerun and themed controls passed the browser workflow again. Renderer/main typechecks and scoped lint pass (existing Blueprint hook/refresh warnings remain), and the production build succeeds with existing chunk/Browserslist warnings. NuGet vulnerability metadata was unreachable during helper build, but compilation succeeded. The source-map/animation fixture test uses `UNREAL_REVIEW_MAP` and `UNREAL_REVIEW_ANIMATION` environment variables and skips on machines without these local assets.

The StateTree browser test is a controlled document fixture, not proof of a particular saved StateTree format. A real saved StateTree and complex nested Animation Blueprint still need editor comparison. The user reports that the initial app/interface works as expected. New external-actor behavior, 200% scaling, packaged reader 9 and other platforms still need their own acceptance.

CUE4Parse and ThreeNative clones remain research inputs and are not embedded, auto-installed, or downloaded by the app. Full mesh geometry, LOD/skeleton/animation playback, dependency-backed level rendering, complete external-world inventory, complete StateTree bindings/transitions, landscapes/foliage, and engine-backed rendering remain open. `.ubulk` and package trailers are not newly captured or decoded. Neither raw-byte differences nor the schematic claim a faithful Unreal visual.

## Phase 2: changed external actor packages

Implemented as an opt-in extension of the same revision service and review host. A verified external actor exposes **Review owning map**; a map exposes **Review changed external actors**. Both keep the selected base/selected refs, map rename paths, direct package navigation and existing binary recovery. Changes, Contents, inspector and schematic combine the root document with loaded changed packages. Source package and original serialized object paths remain inspectable.

Conventional Content/__ExternalActors__ folders supply ownership candidates only. The reader must also expose a saved ActorGuid and an outer reference to the exact map package and PersistentLevel; the owning map must exist on that revision. Alternate/custom mount layouts and __ExternalObjects__ are not implemented. An unresolved owner or unavailable side cannot produce a confirmed semantic addition/removal. Moves between maps are compared conservatively within the selected map scope; they are not reported as proven deletion from the entire project.

Git tree/index/worktree path queries discover changed packages and companion-only edits without decoding unchanged actors. HEAD/parent refs are frozen to commits for a grouped request. Staged and unstaged captures use their actual index/worktree sides; mutable index/package metadata and manifest membership are checked again after capture. If they change, grouped actor data is discarded with Retry guidance. Immutable package documents and ownership fields reuse the existing content/identity caches and compact IPC hydration. No extraction occurs on view/side switches or camera changes.

Each request loads at most 16 changed packages, with a shared 64 MB actor capture budget and 16 MB actor document budget across both revisions. Git manifest output is rejected above 2 MB, and mutable index hashing above 32 MB. LFS declared size is checked before actor retrieval. Existing root capture/helper/queue/cache limits remain. Omitted counts, per-package failures, missing owners and partial inventory are visible. The count refers to changed packages, not every actor in the world. Saved data-layer/reference fields participate in property comparison; inherited values, full-world dependencies and composed world transforms remain unresolved.

Regression evidence: the final 49-check suite covers Blueprint semantics/canvases, PR whole-file choices, Git/LFS, asset review and external actors. Ten external-actor checks cover staged/working edits, companion-only changes, untracked additions/deletions, map renames, actor moves between maps, wrong/missing owners, mutable-capture invalidation, limits, prefetch rejection and compact IPC reuse. The Chromium workflow verifies owning-map navigation, pinned refs, source-package inspection, omission counts and a 480px pane. Controlled document fixtures prove orchestration, not reader fidelity.

A separate real-reader test copies LRS_OGS Content/Variant_Shooter/Lvl_ArenaShooter.umap and __ExternalActors__/Variant_Shooter/Lvl_ArenaShooter/E/U6/02V6M9C5U71IQYCXQMIPPI.uasset into a disposable Git repository. It edits a uniquely matched saved FVector in the copy from X=300 to X=350 centimeters. The root map hashes remain identical; the actual reader reports RelativeLocation.RelativeLocation.X before/after values 300/350 in the owning-map review. The original project asset bytes remain unchanged. This test requires EXTERNAL_ACTOR_FIXTURE and EXTERNAL_ACTOR_MAP environment variables; private assets are not redistributed. Editor ground-truth counts/ownership and representative large-map performance remain pending.

Renderer/main typechecks, scoped lint and production renderer build pass. New helpers/providers or renderer dependencies were not added. The next implementation phase is deeper StateTree extraction and comparison backed by a real saved fixture.

## Manual acceptance

1. Start/rebuild the development app so main/helper both use reader 9. Existing packaged executables must be rebuilt before testing these changes.
2. Select a changed `.umap` or `.uasset` in Timeline. Inspect Changes and both Contents sides; verify values against the saved revisions in Unreal.
3. Open Preview on a traditional map, an Animation Blueprint, a mesh and a StateTree. Check the coverage text against each displayed subset.
4. Right-click a package and choose Open Unreal asset details. Repeat from Content Browser and a PR, verifying the selected revision and rename/deletion behavior.
5. Select a changed external actor with an unchanged root map and use Review owning map, or enable Review changed external actors on the map. Compare saved ownership/values with Unreal, test staged/working revisions and review explicit omissions on a large map.
6. Test fullscreen/Escape, a narrow pane, rapid file selection, offline/missing LFS and Retry. PR merge choices remain whole-file choices.

LG-055, UI-059 and UI-060 remain partial. No broad audit finding is closed by these scoped improvements.

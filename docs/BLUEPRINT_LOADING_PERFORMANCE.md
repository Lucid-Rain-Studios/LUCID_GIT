# Blueprint loading performance

Updated November 14, 2026.

Ordinary revision comparisons now overlap the left and right reads through the
existing two-worker extraction pool. Content-addressed caching, shared in-flight
extraction, repository capture gates, authenticated LFS recovery, and retry
deduplication remain in place. Native geometry and scene requests retain
sequential root reads to avoid increasing their peak memory use. Ordinary cold
comparisons can now use both reader workers at once instead of one after another.

The viewer also starts the shared Klee module import during asset IO, including
the common Unreal asset review entry point. Canvas creation still waits for the
document. Preload errors are handled, and the canvas can retry loading and display
its normal error. This can load Klee for a non-Blueprint uasset too; the module
import is shared across subsequent views.

Verification:

- Renderer and main-process TypeScript checks passed.
- All 34 tests in blueprint-diff, blueprint-viewer, and blueprint-lfs passed.
- A new regression holds both distinct revision extractions at a barrier and
  confirms both start before either finishes, then verifies the decoded sides.
- The real Chromium canvas test holds the asset response and verifies the Klee
  request occurs before releasing it; pan, inspection and fullscreen checks pass.
- The broader unreal-asset-review suite passed two tests, skipped its optional
  local fixture test, and failed its deleted-asset summary expectation at line 89.
  The same failure was reproduced with UnrealAssetReview's original loading code
  (preload removed); its browser fixture mocks revision IPC.

No end-to-end percentage improvement is claimed for production assets. Benefits
depend on decoding time, cache state and whether one or two revisions are shown.

## Graph construction and drawing follow-up

- The first-party Klee adapter now indexes connection endpoints by node name and
  pin identity. Ordered sets preserve the original first-match behavior for
  duplicate identities; removed endpoints and partial wires follow the pinned
  upstream traversal. No third-party checkout was modified.
- Read-only drawing order is sorted once per canvas. Node identities and selection
  lookups are also prepared once rather than repeatedly parsing node source text.
- Theme tokens are read at initialization and on the existing appearance observer,
  rather than per frame/per changed wire. Appearance changes refresh tokens before
  recalculating layout. The adapter retains the existing root style/class observer.
- Wire differences are calculated only for the selected graph. Other graphs still
  receive node-change counts in the menu; selecting another graph computes its
  wire highlights on demand.

The endpoint index uses temporary O(pins) storage during construction; drawing
metadata uses O(nodes + controls) storage for the canvas lifetime. Existing asset
caches, worker limits and LFS behavior are unchanged by this follow-up.

Verification: Blueprint tools rebuilt, renderer/main TypeScript checks passed,
and all 37 tests across blueprint-performance, blueprint-diff, blueprint-viewer,
and blueprint-lfs passed. Tests compare the optimized connection output and
remaining pins against pinned Klee across 200 generated cases, check linear
lookup work at 1,000 and 10,000 wires, check selected-graph comparison, and verify
in Chromium that repeated camera updates make no additional theme-style reads
while a root theme change still updates wire colors. Existing pan, selection,
fullscreen, exact-wire-count and read-only checks pass.

A local synthetic benchmark of 5,000 reciprocal wires / 10,000 pins measured
316.47 ms for upstream traversal and 8.77 ms for indexed traversal (median of seven
runs, real control construction excluded). This isolates connection setup, not
asset extraction, parsing, layout, drawing or end-to-end application latency.

The build succeeded with a NuGet vulnerability-feed connectivity warning; no
dependency versions were changed. The broader asset-viewer failure noted above
remains outside this focused optimization.

Audit tracking: the configured audit directory, reports, finding definitions and
generators are absent from this checkout. No LG-/UI- finding is marked resolved,
and audit progress cannot be calculated here. The saved graph snapshot is from
October 24 and was used only for navigation.

## Missing reader in local packaged app — November 15, 2026

The running executable was the local packaged app at
`Build-app/App_v1.5.0/mac-arm64/Lucid Git.app`, whose Resources directory had no
`blueprint-extractor` directory. The development reader existed, but packaged
apps correctly resolve their reader inside their own Resources directory.

Published the self-contained readers and built a separate replacement at
`Build-app/Blueprint-reader-fixed/mac-arm64/Lucid Git.app`. Its embedded Apple
Silicon reader successfully decoded the UE 5.7 FirstPersonCharacter fixture
(reader version 17, complete, 4 graphs, 37 nodes). The app's deep/strict code
signature verification passed. The original running app was left intact; quit
that copy and open the replacement to use the repaired bundle. The user's exact
PlayerCharacter asset was not available for verification here.

Added an electron-builder beforePack check for target-specific reader binaries,
managed assemblies and core runtime files. Missing/empty files now fail packaging
with the publish command instead of silently producing an app without a reader.
Three regression tests cover macOS, Windows and Linux file layouts, wrong
architectures, universal Mac requirements, and an empty runtime file. All pass;
the production app build also passed. Audit files remain absent, so no finding
IDs or completion counts were changed.

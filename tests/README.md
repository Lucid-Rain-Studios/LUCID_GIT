# Lucid Git regression tests

Run from the repository root after installing dependencies:

```powershell
# Full suite. The pretest script builds the Blueprint tools first.
npm test

# Workflow suite, including main-process compilation; no Unreal editor required.
node node_modules/typescript/bin/tsc -p tsconfig.main.json
node node_modules/@playwright/test/cli.js test tests/usecase-workflows.spec.js
```

Tests run with one worker because services keep shared state and some tests
temporarily replace module methods. Do not enable parallel workers without
isolating those services. Git integration tests require Git and Git LFS on PATH.
Browser tests also require Playwright's Chromium installation.

## Complete workflow coverage

`usecase-workflows.spec.js` adds 24 service integration cases. Fixtures live in
temporary repositories, use local identity/configuration, and communicate only
with local bare remotes. Assertions inspect file bytes, index snapshots, commits,
parents, remote refs and remaining stashes. No production repository or global Git
configuration is changed. The `.uasset`/`.umap` fixtures are synthetic binary data
tracked by real Git LFS; they are not parseable Unreal packages.

| User use case | Evidence asserted |
|---|---|
| Review staged changes, edit again, unstage/restage, then commit | HEAD receives the reviewed snapshot; subsequent edits and unselected work survive. Spaces/brackets, Unicode and leading-dash filenames run separately. |
| Select a literal bracket filename | Staging and unstaging never affect a sibling matched by that filename as a glob. |
| Make the first commit in a new project | Unstage keeps new file bytes; the initial commit includes only the final selection. |
| Discard selected edits and deletions | Selected paths return to HEAD; another staged file and untracked notes survive. |
| Stash selected changes, then Apply or Pop | Modified, deleted and untracked paths round-trip; sibling work survives; the stash retains its original staged and working snapshots. Apply retains the checkpoint, Pop removes it. Apply/Pop are not expected to restore staging without `--index`. |
| Resolve content, add/add, modify/delete and delete/modify conflicts | Both choices run for each conflict kind. Final commits retain both parents, the chosen result and unrelated incoming files. |
| Switch or create a branch when local edits would be overwritten | Rejection preserves the current branch, HEAD, staged snapshot, newer working edits and untracked notes. |
| Try to finalize unresolved conflicts, then Abort | Refused completion leaves index/content/HEAD unchanged; Abort restores the branch and preserves untracked notes. |
| Pop a stash that conflicts | The failed Pop retains its checkpoint; resolution stages the chosen content without creating a commit. Explicit Drop removes only the checkpoint. |
| Review an older Unreal asset while work is stashed | `.uasset` and `.umap` each traverse stash, branch creation, checkout and Pop offline. Full binary bytes survive; committed objects remain LFS pointers. |
| Force push after an unseen teammate update | Real Git rejects the stale lease and preserves both tips. Fetch followed by an explicit force retry succeeds. This tests the ordinary tracking-ref lease, not a lease pinned to a reviewed SHA. |
| Publish a new branch inherited from main after main advances | Fetch discovers the incoming main commit, yet publication creates the feature ref, changes its upstream and leaves remote main intact. |

These supplement existing audit regressions, especially LG-016 (diff baselines),
LG-019 (path identities), LG-024/025 (stashes) and LG-083 (first publication).
Adding tests does not by itself complete or reopen an audit finding.

## Other established contracts

Use these suites when changing the corresponding behavior:

| Area | Existing suites |
|---|---|
| Push fetch preflight, branch identity, force controls and lock policy | `push-preflight`, `push-branch`, `force-push`, `push-locks`, `push-locks-ui`, `pr-revisions`, `branch-menu` |
| Failed merge writes, serialized operations, index recovery and shutdown | `merge-safety`, `merge-progress`, `merge-resolve-gate`, `gate`, `index-recovery`, `index-unblock`, `shutdown` |
| Large stash selections, locks and partial failure | `medium-p2`, `stash-lock`, `stash-conflict`, `bulk-unlock`, `lock-cache-check` |
| Read-only Unreal revisions and LFS retrieval | `blueprint-diff`, `blueprint-lfs`, `unreal-asset-review`, `asset-blame`, `content-browser-blame` |
| Saved map positions, explicit export, selected-side loading, retry and cancellation | `map-preview`, `map-render-feedback`, `preview-performance`, `native-scene`, `native-scene-actors` |
| Mesh/collision/wireframe, LOD, surfaces and animation | `mesh-preview`, `large-mesh-preview`, `native-mesh`, `surface-preview`, `animation-review`, `animation-sequence-review`, `blend-space-review` |
| Repository request races and visible recovery | `status-refresh`, `repository-refresh-warning`, `repository-error-indicator`, `error-panel-modal` |

Names above omit `.spec.js`. Some asset suites need built .NET helpers, real engine
fixtures or an installed Unreal editor; inspect each suite's prerequisites and
reported skips. Browser suites often control IPC, so their results establish
browser behavior under those responses.

Passing these tests does not establish installed Electron behavior, physical
keyboard routing, live GitHub authentication, multi-computer presence, real team
LFS-lock contention or representative large-project performance. Record those
acceptance checks separately; keep the functional and UI audit checkboxes tied to
their own stated verification requirements.

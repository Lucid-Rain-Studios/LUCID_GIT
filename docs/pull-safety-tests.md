# Pull safety regression gate

Run from the project root with Node dependencies and Git LFS installed:

```powershell
npm.cmd run test:pull-safety
```

On other shells, use `npm run test:pull-safety`. The command compiles the main
process before running the tests, avoiding stale compiled service code. Tests
run serially because the service is a singleton. Each test uses disposable
repositories; real GitHub credentials, project files and production locks are
not used. Allow several minutes for Git/LFS process and local-remote tests.

The reusable Windows workflow `.github/workflows/git-safety.yml` runs this
command from CI. The release packaging/publishing job depends on that workflow
succeeding. These checks do not use `continue-on-error`. A new workflow becomes
active only after the changed files are committed/pushed; repository branch
protection settings are separate.

## Coverage

- Text and real LFS assets, fast-forward and divergent history, staged,
  unstaged and mixed edits, and overlapping versus unrelated incoming paths.
- Staged deletion/rename, untracked incoming-path collisions and clean merges.
- Actual TopBar callbacks connected to GitService and a local bare remote:
  Cancel, explicit Stash & Pull, failed stash, and failed Pull after stashing.
- Exact working-file hashes, index tree, HEAD, status and stash preservation.
  Successful Pull is checked for upstream integration rather than merely a
  successful process exit.
- Stash recovery preserves working bytes and the previous stash. A conflicting
  Apply must report failure and retain the stash. The app's plain Apply does
  **not** promise to restore the staging selection; the saved index version is
  independently checked inside the stash.
- A remote update between preflight and Pull must be refused by Git without
  overwriting local edits. Preflight is not a transaction with the remote.
- A group of 200 staged LFS files under paths containing spaces, brackets and
  Unicode survives twelve preflight calls, in three rounds of four concurrent
  callers, with exact content and index preservation.
- The earlier staged-Pull, stale-lock, scoped-status and refresh regressions
  remain part of the gate.
- Watcher metadata noise, logical-index verification (including changes during
  a pending check), linked worktrees, and native Windows stage/commit/save
  notifications. Index checks include staged entries and flags, not stat-cache
  fields, so external staging is detected even during application Git reads.
- Branch-tip hashes batched into branch-list results and fresh after commits;
  combined ahead/behind counts; concurrent UI sync requests, invalidation and
  failure retries. Push safety queries bypass UI request sharing.

## What a new regression should prove

Reproduce the reported topology and index/working-tree state, not just its file
extension. Exercise the entry point used by the user when possible. Capture
HEAD, index and working bytes before the operation, then check the intended
transition and preservation explicitly. Test both confirmation and failure
paths. For a missed preflight, demonstrate that the regression fails with the
old preflight and passes with the fix.

The original divergent/staged-LFS regression was also run with the exact
pre-fix `mergeOverlapFiles` method from Git HEAD injected into the test process:
it failed because the old method returned an empty list instead of the staged
asset. No product file needed to be rewritten for that check.

## Limits

These are Node service tests and deterministic renderer callback tests, not a
packaged Electron UI test. Local remotes exercise Git/LFS plumbing but do not
validate GitHub authentication, real network outages, every Git configuration
(such as rebase/autostash or forced no-fast-forward), or external programs
editing files concurrently. Network/stash failure handling uses explicit fault
injection; the advancing-remote race uses a real second clone.

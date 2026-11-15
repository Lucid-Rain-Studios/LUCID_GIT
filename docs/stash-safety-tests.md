# Stash performance and safety checks

Run `npm run test:stash-safety` from the project root with dependencies and Git
LFS installed. The command compiles the main process, then runs serial tests
against disposable repositories and deterministic renderer callbacks.

The checks cover:

- The explicit save/apply/pop refresh reads file status without requesting branch lists,
  ahead/behind counts or commit history. Stash-list and file-status reads start
  together, including after conflicts or partial failures.
- Drop reloads only the stash list. Stash-ref watcher notifications do not
  trigger working-tree scans; index, working-file and branch events still do.
- Watcher bursts during a stash refresh produce one follow-up scan rather than
  losing external edits. Older responses cannot replace newer file state or
  the active repository's stash list.
- Selected-file save checks only the selected paths and preserves staged,
  unstaged, untracked and unrelated content, including literal/Unicode names.
- Real LFS apply/pop/drop each use one application Git command, preserve HEAD,
  restore the expected bytes, and keep or remove the stash as appropriate.
- Existing stale-lock recovery, conflict resolution, failed Pop retention and
  offline Unreal asset round-trip regressions remain covered.

These checks establish command counts, response ordering and data preservation;
they do not establish a wall-clock speedup on INFERIUS. Native Windows watcher
tests run only on Windows. Packaged Electron and representative large-repository
timings remain manual acceptance checks.

Stash mutations remain serialized by the repository write gate. A watcher
notification during a status scan conservatively requires a fresh follow-up,
because an external editor may have changed a file after the first scan began.
The explicit file-status refresh skips project discovery unless dirty paths
include a `.uproject` file. Watcher follow-ups retain their broader refresh so
external branch or project changes are still detected.

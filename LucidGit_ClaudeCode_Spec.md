# Lucid Git — Git Client for Game Developers
## Claude Code Build Specification — v2.5 (Audited)

---

## Overview

Build **Lucid Git**, a cross-platform desktop Git client built with **Electron + React + TypeScript**, purpose-built for game development teams (especially Unreal Engine 5). It replaces GitHub Desktop with a far more capable tool that handles binary files, LFS, file locking, `.git` size management, and provides rich developer feedback at every step.

**Non-goals:** Lucid Git does not require Redis, Node, or Git to be pre-installed by end users. It must run after a single installer with no external dependencies.

---

## Tech Stack (verified)

| Layer | Technology | Why |
|---|---|---|
| Shell | Electron 33+ | Cross-platform desktop |
| Frontend | React 18 + TypeScript | Industry standard for Electron UIs |
| Styling | Tailwind CSS + shadcn/ui | Fast, composable, good defaults |
| State (UI) | Zustand | Simple, no boilerplate |
| State (async/cache) | `@tanstack/react-query` | Handles git data cache + invalidation |
| Git operations | `dugite` ^3.2 (bundled Git + LFS binaries) | No system Git required |
| Auth | GitHub Device Flow OAuth | No callback server needed for a desktop app |
| Secure storage | `keytar` (OS keychain) | Tokens never hit disk in plaintext |
| Non-secret settings | `electron-store` | JSON in userData dir |
| Background jobs | Node `worker_threads` + in-process queue (`p-queue`) | **No Redis required** |
| Notifications | Electron `Notification` API | Native OS notifications |
| DB (local) | SQLite via `better-sqlite3` | Notification log, repo metadata |
| Editor/Diff | `monaco-editor` via `@monaco-editor/react` | Same engine as VS Code |
| HTTP | Native `fetch` (Node 18+) | No extra dep for Discord webhooks |
| Packaging | `electron-builder` ^25 | Cross-platform installers |
| Auto-update | `electron-updater` | GitHub Releases as update server |

**Key corrections from v1.1:**
- ❌ Removed `bull` (requires Redis — would break one-click install) → ✅ `p-queue` (in-process, zero runtime dep)
- ❌ Removed `simple-git` (requires system Git; redundant with dugite) → ✅ `dugite` only
- ❌ Removed `react-virtual` v2 (deprecated) → ✅ `@tanstack/react-virtual` v3
- ❌ Removed `node-fetch` (not needed, Node 18+ has native `fetch`)
- ❌ OAuth2 PKCE doesn't work cleanly without a callback URL → ✅ GitHub **Device Flow** (built for desktop apps)
- ✅ Corrected dugite API: it's `exec()` not `git()`

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Renderer (React)                    │
│  UI components, Zustand stores, React Query caches  │
└────────────────────┬────────────────────────────────┘
                     │ IPC (contextBridge, typed)
┌────────────────────┴────────────────────────────────┐
│                 Main (Node)                          │
│  ┌────────────────────────────────────────────┐    │
│  │  Services (singletons)                      │    │
│  │  GitService, LockService, LFSService,       │    │
│  │  CleanupService, NotificationService,       │    │
│  │  AuthService, ErrorParser                   │    │
│  └──────────────┬─────────────────────────────┘    │
│                 │                                    │
│  ┌──────────────┴─────────────────────────────┐    │
│  │  Worker threads (p-queue)                   │    │
│  │  runs git operations off main thread        │    │
│  └────────────────────────────────────────────┘    │
│                                                      │
│  dugite (bundled git + git-lfs binaries)            │
│  keytar (OS keychain)                               │
│  better-sqlite3 (local DB)                          │
└──────────────────────────────────────────────────────┘
```

---

## Project Structure

```
lucid-git/
├── package.json
├── electron-builder.yml
├── tsconfig.json
├── tsconfig.main.json        # main process uses CommonJS
├── tsconfig.renderer.json    # renderer uses ESM
├── vite.config.ts            # renderer bundler
├── .github/
│   └── workflows/
│       ├── ci.yml            # lint + typecheck on PR
│       └── release.yml       # builds + publishes on tag
├── assets/
│   ├── icon.ico              # Windows
│   ├── icon.icns             # macOS
│   └── icon.png              # Linux + in-app
├── electron/
│   ├── main.ts               # App entry, window mgmt, IPC registration
│   ├── preload.ts            # contextBridge — typed IPC surface
│   ├── ipc/
│   │   ├── channels.ts       # IPC channel name constants
│   │   └── handlers.ts       # Maps channel → service method
│   ├── services/
│   │   ├── GitService.ts
│   │   ├── LockService.ts
│   │   ├── LFSService.ts
│   │   ├── CleanupService.ts
│   │   ├── ShallowCloneService.ts
│   │   ├── NotificationService.ts
│   │   ├── AuthService.ts
│   │   ├── LogService.ts         # Session log — last 5 sessions, auto-suggestions
│   │   ├── UnrealService.ts
│   │   ├── AssetDiffService.ts
│   │   ├── UEHeadlessService.ts
│   │   ├── DependencyService.ts
│   │   ├── HeatmapService.ts
│   │   ├── ForecastService.ts
│   │   ├── HookService.ts
│   │   └── ErrorParser.ts
│   ├── workers/
│   │   └── git-worker.ts     # Long-running git ops run here
│   ├── db/
│   │   ├── schema.sql
│   │   └── migrations.ts
│   └── util/
│       ├── dugite-exec.ts    # Wraps dugite with progress streaming
│       └── git-log-parse.ts  # Parses --format output
├── src/                      # Renderer
│   ├── main.tsx
│   ├── App.tsx
│   ├── ipc.ts                # Typed wrappers around window.lucidGit.*
│   ├── components/
│   │   ├── layout/
│   │   │   ├── AppShell.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   ├── TopBar.tsx    # Notification bell, update banner
│   │   │   └── StatusBar.tsx # Progress strip
│   │   ├── auth/
│   │   │   ├── DeviceFlowLogin.tsx
│   │   │   └── AccountSwitcher.tsx
│   │   ├── repo/
│   │   │   ├── RepoList.tsx
│   │   │   ├── CloneDialog.tsx
│   │   │   └── BranchSelector.tsx
│   │   ├── changes/
│   │   │   ├── FileTree.tsx
│   │   │   ├── FileRow.tsx
│   │   │   ├── FileLockBadge.tsx
│   │   │   ├── StagingArea.tsx
│   │   │   └── CommitBox.tsx
│   │   ├── diff/
│   │   │   ├── TextDiff.tsx       # monaco-based
│   │   │   └── BinaryDiff.tsx     # size / hash / metadata
│   │   ├── conflicts/
│   │   │   ├── ConflictPreview.tsx    # Pre-merge flight check
│   │   │   ├── ConflictCard.tsx       # Per-file card
│   │   │   ├── TextResolver.tsx
│   │   │   └── BinaryResolver.tsx
│   │   ├── history/
│   │   │   ├── CommitGraph.tsx
│   │   │   ├── CommitDetail.tsx
│   │   │   └── RestoreDialog.tsx
│   │   ├── progress/
│   │   │   ├── OperationProgress.tsx
│   │   │   └── StepTracker.tsx
│   │   ├── lfs/
│   │   │   ├── LFSManager.tsx
│   │   │   └── LFSAutoDetect.tsx
│   │   ├── cleanup/
│   │   │   ├── GitCleaner.tsx
│   │   │   ├── ShallowCloneManager.tsx
│   │   │   └── SizeDashboard.tsx
│   │   ├── notifications/
│   │   │   ├── NotificationBell.tsx
│   │   │   ├── NotificationFeed.tsx
│   │   │   └── WatchFileButton.tsx
│   │   ├── viewer/
│   │   │   └── AssetViewerPanel.tsx  # right-side asset preview overlay (Section 21)
│   │   ├── ui/
│   │   │   ├── Tooltip.tsx           # portal-based global tooltip (Section 22)
│   │   │   ├── PanelErrorBoundary.tsx # per-panel crash recovery (Section 23)
│   │   │   └── GlobalDialogs.tsx     # themed modal system (Section 19)
│   │   ├── logs/
│   │   │   └── BugLogsPanel.tsx  # Scrollable session log, suggestion box, save-to-txt
│   │   ├── errors/
│   │   │   └── ErrorPanel.tsx
│   │   ├── unreal/
│   │   │   ├── UProjectDetector.tsx
│   │   │   ├── GitAttributesEditor.tsx
│   │   │   └── GitIgnoreEditor.tsx
│   │   ├── diff/
│   │   │   ├── TextDiff.tsx       # monaco-based
│   │   │   ├── BinaryDiff.tsx     # size / hash / metadata
│   │   │   └── AssetDiffViewer.tsx  # replaces BinaryDiff for recognised UE types
│   │   ├── blame/
│   │   │   ├── DependencyBlamePanel.tsx
│   │   │   └── ReferenceViewer.tsx
│   │   ├── heatmap/
│   │   │   └── LockHeatmap.tsx
│   │   ├── forecast/
│   │   │   └── ForecastPanel.tsx
│   │   ├── hooks/
│   │   │   └── HooksManager.tsx
│   │   ├── settings/
│   │   │   ├── SettingsPage.tsx
│   │   │   ├── GeneralSettings.tsx
│   │   │   ├── LFSSettings.tsx
│   │   │   ├── CleanupScheduler.tsx
│   │   │   ├── DiscordWebhookSettings.tsx
│   │   │   └── NotificationSettings.tsx
│   │   └── command-palette/
│   │       └── CommandPalette.tsx
│   ├── stores/
│   │   ├── authStore.ts
│   │   ├── repoStore.ts
│   │   ├── operationStore.ts
│   │   ├── lockStore.ts
│   │   ├── notificationStore.ts
│   │   ├── assetViewerStore.ts       # open/close state for AssetViewerPanel
│   │   └── dialogStore.ts            # Promise-based custom dialog state
│   ├── hooks/
│   │   ├── useRepoStatus.ts
│   │   ├── useLocks.ts
│   │   └── useOperation.ts
│   └── lib/
│       ├── formatters.ts
│       ├── gitErrors.ts
│       ├── unrealAssets.ts
│       └── discordEmbeds.ts
└── tests/
    ├── unit/
    └── e2e/                   # Playwright for electron
```

---

## IPC Contract (must be defined first)

Claude Code builds this **before** any services, so the contract is fixed up front and everything downstream has a stable interface.

```typescript
// electron/ipc/channels.ts
export const CHANNELS = {
  // Auth
  AUTH_START_DEVICE_FLOW: 'auth:start-device-flow',
  AUTH_POLL_DEVICE_FLOW: 'auth:poll-device-flow',
  AUTH_LIST_ACCOUNTS: 'auth:list-accounts',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_SET_CURRENT_ACCOUNT: 'auth:set-current-account',

  // Git core
  GIT_CLONE: 'git:clone',
  GIT_STATUS: 'git:status',
  GIT_STAGE: 'git:stage',
  GIT_UNSTAGE: 'git:unstage',
  GIT_COMMIT: 'git:commit',
  GIT_PUSH: 'git:push',
  GIT_PULL: 'git:pull',
  GIT_FETCH: 'git:fetch',
  GIT_LOG: 'git:log',
  GIT_BRANCH_LIST: 'git:branch-list',
  GIT_CHECKOUT: 'git:checkout',
  GIT_MERGE_PREVIEW: 'git:merge-preview',  // Pre-merge flight check
  GIT_MERGE: 'git:merge',

  // Locks
  LOCK_FILE: 'lock:file',
  LOCK_UNLOCK: 'lock:unlock',
  LOCK_LIST: 'lock:list',
  LOCK_WATCH: 'lock:watch',           // "notify me when unlocked"

  // LFS
  LFS_STATUS: 'lfs:status',
  LFS_TRACK: 'lfs:track',
  LFS_MIGRATE: 'lfs:migrate',
  LFS_AUTODETECT: 'lfs:autodetect',

  // Cleanup
  CLEANUP_SIZE: 'cleanup:size',
  CLEANUP_GC: 'cleanup:gc',
  CLEANUP_PRUNE_LFS: 'cleanup:prune-lfs',
  CLEANUP_SHALLOW: 'cleanup:shallow',
  CLEANUP_UNSHALLOW: 'cleanup:unshallow',

  // Notifications + webhooks
  NOTIFICATION_LIST: 'notification:list',
  NOTIFICATION_MARK_READ: 'notification:mark-read',
  WEBHOOK_TEST: 'webhook:test',
  WEBHOOK_SAVE: 'webhook:save',

  // Unreal
  UE_DETECT: 'ue:detect',
  UE_WRITE_GITATTRIBUTES: 'ue:write-gitattributes',
  UE_WRITE_GITIGNORE: 'ue:write-gitignore',

  // Asset diff previews (binary renderer)
  ASSET_DIFF_PREVIEW: 'asset:diff-preview',
  ASSET_RENDER_THUMBNAIL: 'asset:render-thumbnail',
  ASSET_EXTRACT_METADATA: 'asset:extract-metadata',
  ASSET_BLUEPRINT_DIFF: 'asset:blueprint-diff',

  // Dependency-aware blame
  DEP_BUILD_GRAPH: 'dep:build-graph',
  DEP_BLAME_ASSET: 'dep:blame-asset',
  DEP_LOOKUP_REFERENCES: 'dep:lookup-references',
  DEP_REFRESH_CACHE: 'dep:refresh-cache',

  // Lock heatmap + conflict forecasting
  HEATMAP_COMPUTE: 'heatmap:compute',
  FORECAST_REMOTE_EDITS: 'forecast:remote-edits',
  FORECAST_POLL_START: 'forecast:poll-start',
  FORECAST_POLL_STOP: 'forecast:poll-stop',
  FORECAST_PUBLISH_WIP: 'forecast:publish-wip',  // user-initiated opt-in share

  // Bug logging
  LOG_GET_TEXT: 'log:get-text',
  LOG_GET_SUGGESTION: 'log:get-suggestion',
  LOG_SAVE_DIALOG: 'log:save-dialog',

  // Events (main → renderer, one-way)
  EVT_OPERATION_PROGRESS: 'evt:operation-progress',
  EVT_LOCK_CHANGED: 'evt:lock-changed',
  EVT_NOTIFICATION: 'evt:notification',
  EVT_UPDATE_AVAILABLE: 'evt:update-available',
  EVT_DEP_GRAPH_READY: 'evt:dep-graph-ready',
  EVT_FORECAST_CONFLICT: 'evt:forecast-conflict',
} as const
```

Every service method has a matching IPC handler and a typed renderer wrapper. Claude Code generates all three in lockstep.

---

## Feature Specifications

### 1. Authentication — GitHub Device Flow

**Why Device Flow not PKCE:** Desktop apps can't reliably register an OAuth callback URL. Device Flow is purpose-built for this — the user is shown a code, opens github.com/login/device in their browser, enters the code, and the app polls for the token.

**Flow:**
1. App calls `POST https://github.com/login/device/code` with client_id + scopes
2. GitHub returns `user_code`, `device_code`, `verification_uri`, `interval`
3. App displays `user_code` + an "Open GitHub" button that opens `verification_uri`
4. App polls `POST https://github.com/login/oauth/access_token` every `interval` seconds
5. On success, token stored via `keytar.setPassword('lucid-git', 'github:{userId}', token)`

**Scopes:** `repo`, `write:lfs`, `read:user`

**Git subprocess authentication:**

The OAuth token stored in keytar is used for both the GitHub REST API (IPC calls) and all git subprocess commands that make HTTPS requests. For subprocess auth, the token is injected via `git -c http.https://github.com/.extraheader=AUTHORIZATION: basic <base64>` rather than relying on the OS credential manager — this works on any machine regardless of credential helper setup.

```typescript
// electron/util/dugite-exec.ts
export function gitAuthArgs(token: string | null): string[] {
  if (!token) return []
  const b64 = Buffer.from(`x-access-token:${token}`).toString('base64')
  return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${b64}`]
}
```

`AuthService.getCurrentToken()` reads `currentAccountId` from `auth.json` then retrieves the token from keytar. Every network git operation (clone, push, pull, fetch, deleteRemoteBranch, updateFromMain, setUpstream, cleanupShallow, cleanupUnshallow) and every LFS operation (listLocks, lockFile, unlockFile) prepends `gitAuthArgs(await authService.getCurrentToken())` to its args. When no token is available, `gitAuthArgs()` returns `[]` (no-op).

**Providers (v1):** GitHub, GitHub Enterprise. GitLab/Bitbucket deferred to v2.

**UI:**
- Large monospace code display with countdown to expiry
- "Copy code" + "Open GitHub" buttons
- Animated indeterminate progress bar at the top of the dialog, active for the entire polling duration, so users know authorization is still in progress
- Polling status text alternates: "Waiting for authorization…" ↔ "Checking for authorization…"
- Pressing × (close) while polling is active shows an inline warning block ("Authentication will be incomplete") with "Cancel authentication" and "Keep waiting" options — the dialog never closes silently mid-poll
- Account badge in top bar; Settings → Accounts → Add / Sign out

**Account persistence:**
`AuthService.setCurrentAccount(userId)` reads `auth.json`, updates `currentAccountId` only if the userId exists in the accounts array, then writes back. The frontend `authStore.setCurrentAccount()` calls this via `ipc.setCurrentAccount(userId)` (fire-and-forget) in addition to updating local state, so account selection survives app restarts.

---

### 2. File Locking (Git LFS Locks)

Critical for UE `.uasset`, `.umap`, `.png`, `.wav`, etc.

**Implementation:**
```typescript
// services/LockService.ts
class LockService {
  async lockFile(repoPath: string, filePath: string): Promise<Lock>
  async unlockFile(repoPath: string, filePath: string, force?: boolean): Promise<void>
  async listLocks(repoPath: string): Promise<Lock[]>       // git lfs locks --json
  async watchFile(repoPath: string, filePath: string): Promise<void>  // stored in SQLite
  async isLockedByOther(repoPath: string, filePath: string): Promise<boolean>
  async lockBatch(repoPath: string, filePaths: string[]): Promise<BatchLockResult>
  startPolling(repoPath: string, intervalMs: number): void  // emits EVT_LOCK_CHANGED
}
```

Poll loop runs in main process; diffs previous locks vs current; emits `EVT_LOCK_CHANGED` events; for any watched file that transitioned to unlocked, fires notification + clears watch.

**UI Behavior:**
- File tree badges: 🔒 locked by you | ⚠️ locked by teammate | 🔓 unlocked
- Right-click: Lock / Unlock / Force Unlock (with confirmation)
- Stage blocker if file locked by someone else — dialog shows who + email
- "My Locks" panel
- Auto-unlock on merge/commit (optional setting)
- Warn before checkout if incoming branch has locked files you've modified
- Live badges update on `EVT_LOCK_CHANGED`

**Team locks grouped by owner:**
In the Team tab of the Locked Files panel, locks are grouped by owner login with collapsible sections. Each group shows the owner's avatar (initials fallback), display name, lock count badge, and a chevron that rotates when collapsed. Collapsed state is tracked in local React state (`Set<string>`) keyed by owner login. The Mine tab remains a flat list.

**Lock Notifications (in-app):**
- Teammate locks a file → Electron system notification
- A lock you're watching is released → high-priority notification with one-click lock action
- Right-click any locked file → "Notify me when unlocked"
- Notification bell in top bar with full history for the current repo
- Per-repo, per-file-type filters (e.g. only notify on `.umap` locks)

---

### 3. Smart Merge Conflict Resolution & Pre-merge Flight Check

**Text conflicts:**
- Monaco-based 3-way merge (yours / base / theirs)
- Accept ours / Accept theirs / Accept both / Custom per-block
- Syntax highlighting per file type
- "Mark as resolved" per file

**Binary conflicts:**
- No auto-merge for `.uasset` / `.umap` — show clear binary conflict UI
- "Keep mine" / "Keep theirs" / "Open file manager to choose manually"
- Show metadata: file size, last modified, author, commit message per branch

**Pre-merge Flight Check — implementation:**

```typescript
// GitService.mergePreview(repoPath, targetBranch)
// 1. git merge-tree --write-tree --name-only HEAD <targetBranch>
//    → returns list of conflicting paths without actually merging (Git 2.38+)
// 2. For each path, collect metadata:
//    - git log -1 --format='%an|%ae|%at|%s' HEAD -- <path>          (ours)
//    - git log -1 --format='%an|%ae|%at|%s' <targetBranch> -- <path> (theirs)
//    - git cat-file -s HEAD:<path>                                   (our size)
//    - git cat-file -s <targetBranch>:<path>                         (their size)
// 3. Classify type from extension (.uasset/.umap → ue-asset, etc.)
// 4. Return ConflictPreviewFile[]
```

dugite ships a recent Git, so `merge-tree --write-tree` is available.

```typescript
interface ConflictPreviewFile {
  path: string
  type: 'text' | 'binary' | 'ue-asset'
  conflictType: 'content' | 'binary' | 'delete-modify'
  ours: {
    branch: string
    lastContributor: { name: string; email: string; avatarUrl?: string }
    lastEditedAt: Date
    lastCommitMessage: string
    sizeBytes: number
  }
  theirs: {
    branch: string
    lastContributor: { name: string; email: string; avatarUrl?: string }
    lastEditedAt: Date
    lastCommitMessage: string
    sizeBytes: number
  }
}
```

**UI:**
- Card per conflicting file with both contributors side-by-side
- Sort by most recently edited first
- `TEXT` vs `BINARY` badge per card
- "Proceed with merge" / "Abort" at the bottom — never silently start a doomed merge

---

### 4. Progress System

Every long-running op (fetch, pull, push, merge, GC, LFS migrate) emits:

```typescript
interface OperationStep {
  id: string
  label: string           // e.g. "Uploading LFS objects (47/203)"
  status: 'pending' | 'running' | 'done' | 'error'
  progress?: number       // 0–100
  detail?: string         // e.g. "textures/T_Ground_D.uasset (24.3 MB)"
  duration?: number       // ms elapsed
}
```

Progress parsed from Git stderr (`--progress` flag):
```typescript
// util/dugite-exec.ts
export async function execWithProgress(
  args: string[],
  repoPath: string,
  onProgress: (step: OperationStep) => void
): Promise<ExecResult> {
  const proc = GitProcess.spawn(args, repoPath)
  proc.stderr.on('data', (chunk) => {
    const step = parseGitProgress(chunk.toString())
    if (step) onProgress(step)
  })
  // ...
}
```

LFS progress parsed from `git lfs push` stderr:
`Uploading LFS objects: 47% (42/89), 412 MB | 8.3 MB/s`

**UI:** Bottom strip always visible during ops, expandable step list, ETA, cancel button, post-op summary ("Push complete — 14 files, 3 LFS objects (847 MB) in 12s"), toast for background ops.

---

### 5. .git Size Management & History Optimization

**Shallow Clone Manager — honest about Git's constraints:**
- `git clone --depth N --shallow-since=DATE` for initial shallow clone
- `git fetch --unshallow` to restore full history (permanent for that working copy)
- "Re-shallowing" after unshallow isn't a native Git operation. Lucid Git does it by: cloning a new shallow copy in a temp dir, copying the user's working changes over, swapping directories atomically.

**Features:**
- Set per-repo local history depth (last 90 days, last 500 commits, etc.)
- Full history always retrievable from remote
- "Time travel" restore: unshallow → checkout any commit → create restore branch → offer to re-shallow
- Size dashboard: `.git/objects/` breakdown, LFS cache, pack files, logs (via `git count-objects -v -H`)

**Cleanup Service:**
```typescript
class CleanupService {
  async getRepoSize(repoPath: string): Promise<SizeBreakdown>
  async runGC(repoPath: string, aggressive?: boolean): Promise<CleanupResult>
  async pruneRemoteRefs(repoPath: string): Promise<void>
  async expireLFSCache(repoPath: string, olderThanDays: number): Promise<void>
  async fullSweep(repoPath: string): Promise<CleanupReport>
}
```

**Scheduled Cleanup:**
- Weekly / monthly schedule
- Before/after size bar chart
- "Quick clean" (safe, fast) vs "Deep clean" (`gc --aggressive`)
- LFS object pruning for files not needed by current branch

---

### 6. Error Resolution System

Every git error parsed and returned as:

```typescript
interface LucidGitError {
  code: string              // internal error code
  gitMessage: string        // raw git output
  title: string             // human-readable title
  description: string       // plain-English explanation
  causes: string[]          // likely reasons
  fixes: FixStep[]          // ordered list of things to try
  docsUrl?: string
  severity: 'warning' | 'error' | 'fatal'
  canAutoFix: boolean
}

interface FixStep {
  label: string
  command?: string          // shell command if applicable
  action?: FixAction        // serializable dispatch descriptor (not a function!)
}

// FixAction must be serializable across IPC — so it's a discriminated union, not a callback:
type FixAction =
  | { type: 'reauth' }
  | { type: 'open-conflict-resolver'; repoPath: string }
  | { type: 'run-lfs-migrate'; patterns: string[] }
  | { type: 'open-settings'; section: string }
  | { type: 'set-upstream'; branch: string }
  | { type: 'abort-rebase' }
  | { type: 'clean-pack-files' }
  | { type: 'increase-buffer' }
  | { type: 'retry-with-ssh' }
```

The renderer has a dispatcher that maps each `FixAction` type to actual UI/IPC behavior. This avoids the previous spec's bug of trying to send functions across IPC.

**Error library (14 codes minimum):**
- `EAUTH`, `MERGE_CONFLICT`, `LFS_LOCK_CONFLICT`, `PUSH_REJECTED`, `DETACHED_HEAD`, `LARGE_FILE_NO_LFS`, `LFS_QUOTA_EXCEEDED`, `PACK_CORRUPT`, `NO_UPSTREAM`, `STASH_CONFLICT`, `REBASE_ABORT_NEEDED`, `PERMISSION_DENIED`, `NETWORK_TIMEOUT`, `DISK_SPACE`

**`EAUTH` causes and fixes (updated):**

Causes include: token missing / expired / revoked, token scopes insufficient, **token not authorized for organization SSO** (the most common field scenario — the user is authenticated but the org requires SSO authorization of the OAuth token separately).

Fixes include: Sign in again, Verify token scopes, **Authorize token for org SSO** → `github.com → Settings → Applications → find this app → Grant`.

**UI:** Error panel slides up, color-coded, "Fix automatically" when `canAutoFix`, copy-command buttons per step, persistent error history log.

---

### 7. Notification System & Discord Webhooks

**In-app notification center:**
- Bell icon with unread count
- Per-repo feed: locks, conflict warnings, teammate pushes to shared branches, cleanup completions
- Persisted in SQLite — full history
- Click notification → jump to relevant file/branch/commit

**Discord Webhook Integration:**

```typescript
class NotificationService {
  async sendDiscordNotification(webhookUrl: string, event: LucidGitEvent): Promise<void>
  async testWebhook(webhookUrl: string): Promise<boolean>
  async getWebhookSettings(repoPath: string): Promise<WebhookConfig>
  async saveWebhookSettings(repoPath: string, config: WebhookConfig): Promise<void>
}

interface WebhookConfig {
  url: string
  enabled: boolean
  events: {
    fileLocked: boolean
    fileUnlocked: boolean
    mergeConflictDetected: boolean
    pushToMain: boolean
    branchCreated: boolean
    forceUnlock: boolean
    largeFileWarning: boolean
    fatalError: boolean
    cleanupCompleted: boolean
    branchDeleted: boolean
  }
  mentionRoles?: string[]
  quietHours?: { start: string; end: string }
}
```

Posted via native `fetch`:
```typescript
await fetch(webhookUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'Lucid Git',
    avatar_url: 'https://.../lucid-git-icon.png',
    embeds: [buildEmbed(event)]
  })
})
```

Rate-limit handling: Discord returns 429 with `Retry-After`. Queue via `p-queue` with concurrency=1 per webhook URL, respect backoff.

**Discord message formats — rich embeds:**

```
🔒 File Locked
Alex Turner locked Content/Characters/Hero/SK_Hero.uasset
Branch: feature/hero-rework  |  Repo: INFERIUS
3 minutes ago
[View in Lucid Git]  [Contact Alex]
```

```
⚠️ Merge Conflicts Detected
8 conflicts found before merging feature/lighting → main
Binary conflicts (need manual choice): 3
  • Content/Maps/L_TownCenter.umap — last edited by Jordan (2h ago)
  • Content/Maps/L_Forest.umap — last edited by Alex (yesterday)
  • Content/Characters/NPC_Vendor.uasset — last edited by Sam (4h ago)
Text conflicts (auto-resolvable): 5
```

```
✅ File Unlocked — Available Now
Content/Characters/Hero/SK_Hero.uasset is now free
Previously locked by: Alex Turner
Lock held for: 2h 14m
[Lock it now]
```

**Settings UI:** Per-repo webhook URL field + "Test Webhook" button, checkbox list for events, embed preview, optional separate webhooks per category.

**Event triggers that fire Discord notifications:**

| Event | Severity |
|---|---|
| File locked | Info |
| File unlocked | Info |
| Merge conflict detected (pre-flight) | Warning |
| Push to main/master | Info |
| Force unlock (another user's lock) | Warning — @mention lock owner |
| Large file pushed without LFS | Warning |
| Fatal git error | Critical |
| Cleanup completed (size saved) | Info |
| Branch deleted | Info |

**Storage note:** Webhook URL in `electron-store` (non-secret per-repo setting). OAuth tokens go in keychain.

---

### 8. Unreal Engine Specific Features

**Auto-detect UE project:**
- Glob `.uproject` in repo root
- Auto-suggest LFS patterns: `*.uasset *.umap *.udk *.ubulk *.upk *.pak *.uexp *.ucas`
- Offer to write `.gitattributes` with LFS + binary flags

**`.gitignore` manager:**
- Built-in UE5-optimized template as a bundled asset
- Visual editor for DDC, Saved/, Intermediate/, Binaries/
- Warning if `DerivedDataCache/` accidentally tracked

**Check-out-for-edit workflow (Perforce-style, optional setting):**
- One-click: lock + stage for modification
- "Submit" = unlock + commit + push atomically

**Pak size estimator:**
- Walk staged files, sum sizes of files matching LFS patterns
- Warn if single commit adds > configurable threshold (e.g. 500 MB raw assets)

---

### 9. Branch & History Visualization

- `git log --all --graph --format=%H|%P|%an|%at|%s` parsed into a graph model
- Custom lane allocator (~200 lines) — faster and leaner than d3
- Branch lanes, merge commits, tags, PR status badges (open / merged / draft / CI status via GitHub API)
- Filter by author, date range, file path
- "Restore to this commit" creates a safety branch first
- Tag manager
- Cherry-pick via drag-and-drop on graph

**Undo commit (soft reset):**
Right-clicking any commit in the History panel exposes "Undo commit (soft reset)" as the first context menu item. The action calls `ipc.gitResetTo(repoPath, commit.parentHashes[0], 'soft')`, which unstages the commit's changes back to the working tree without losing any edits. Root commits (no parent) are guarded — the option is a no-op for those. A confirmation dialog is shown before the reset executes.

---

### 10. Pre-commit Hooks UI

- Reads `.git/hooks/`, shows enable/disable toggles
- Built-in library: file size guard, `.uasset` validation, lint
- Inline hook output before commit completes
- Bypass requires explicit confirmation (not silent `--no-verify`)

---

### 11. Performance

- Worker threads for: clone, fetch, push, pull, gc, lfs-migrate, merge
- `@tanstack/react-virtual` for file trees > 500 rows
- React Query 30s stale time for repo status
- Debounced file watcher events (100ms)
- Incremental diff computation — don't re-diff unchanged files

---

### 12. Distribution — One-Click Install

**Bundling:**
- `dugite` downloads platform-specific Git + LFS binaries in its postinstall
- `electron-builder` bundles these automatically via `asarUnpack`
- No admin rights needed on install (user-space by default)

**Per-platform output:**

| Platform | Installer | Notes |
|---|---|---|
| Windows | `.exe` (NSIS) | Installs to AppData, Start Menu shortcut, optional desktop icon |
| macOS | `.dmg` | Drag-to-Applications; unsigned requires right-click → Open |
| Linux | `.AppImage` | Single portable file |

**`electron-builder.yml`:**
```yaml
appId: com.yourteam.lucid-git
productName: Lucid Git
directories:
  output: dist
  buildResources: assets
files:
  - "dist-electron/**/*"
  - "dist-renderer/**/*"
  - "package.json"
asarUnpack:
  - "node_modules/dugite/**/*"        # Git binaries must be outside asar
  - "node_modules/keytar/**/*"        # Native module
  - "node_modules/better-sqlite3/**/*"
win:
  target: nsis
  icon: assets/icon.ico
mac:
  target: dmg
  icon: assets/icon.icns
  hardenedRuntime: true
  category: public.app-category.developer-tools
linux:
  target: AppImage
  icon: assets/icon.png
  category: Development
publish:
  provider: github
  releaseType: release
```

**GitHub Actions (`.github/workflows/release.yml`):**
```yaml
name: Release
on:
  push:
    tags: ['v*']
jobs:
  release:
    strategy:
      matrix:
        os: [windows-latest, macos-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run build
      - run: npx electron-builder --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # Optional for macOS signing:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
```

**Auto-updater:** `electron-updater` checks GitHub Releases on launch, banner in TopBar, delta updates, stable/beta channels.

**First-run experience for teammates:**
1. Download installer from GitHub Releases
2. Run installer — no prompts, no dependencies
3. Lucid Git opens → welcome screen → "Sign in with GitHub" (Device Flow)
4. Authorize in browser → paste repo URL or pick from their repos → done

**Team config sync:**
- Export `.lucid-git-config.json` — share with team
- Repo-level `.lucid-git/team-config.json` committed to repo: new teammates inherit Discord webhooks, LFS patterns, notification prefs on first clone

---

### 13. Binary Asset Diff Previews

Git shows `.uasset`, `.umap`, textures, and other binaries as opaque blobs. Lucid Git renders **actual visual diffs** so reviewers and teammates can see what changed without launching the editor.

**Scope — what we support at v1:**

| Asset type | Diff treatment | Backend |
|---|---|---|
| Textures (.png, .tga, .bmp, .jpg, .tif, .exr, .hdr, .psd) | Side-by-side image render + pixel-diff overlay + resolution/format/size delta | `sharp` (native image lib bundled with Electron) |
| Blueprints (.uasset containing UBlueprint) | Node-graph diff using UE's `DiffAssets` commandlet | Headless UE invocation |
| Materials (.uasset containing UMaterial / UMaterialInstance) | Parameter diff + node-graph diff | Headless UE invocation |
| Static/Skeletal Meshes (.uasset containing UStaticMesh / USkeletalMesh) | Bounds/vert-count/material-slot delta + thumbnail comparison | UE thumbnail cache + metadata |
| Levels (.umap) | Actor add/remove/move list + overhead minimap snapshot | Headless UE commandlet |
| Data Tables / Curve Tables | Row-level text diff after CSV export | UE `DataTableCSVExporter` commandlet |
| Audio (.wav, .ogg, .mp3, .flac) | Waveform render + duration/sample-rate delta | `fluent-ffmpeg` + `sharp` |
| Video (.mp4, .mov, .bk2) | First-frame + middle-frame thumbnail + duration | `fluent-ffmpeg` |
| Generic .uasset | Fallback: thumbnail extracted from UE `AssetRegistry.bin` cache + metadata delta | Thumbnail cache reader |

**Why headless UE works — and its honest cost:**

Unreal ships `UnrealEditor-Cmd.exe` (Windows) / `UnrealEditor` (Mac/Linux) which accepts `-run=DiffAssets` and similar commandlets. Lucid Git doesn't embed UE; it *invokes* the user's already-installed UE. Cold-start on first invocation is 15–45s; warm invocations reuse a persistent editor process via a persistent-process pool. Output is a structured JSON written to a temp path.

This means: **the user must have UE installed, and the engine version must match the project's `.uproject` EngineAssociation.** If UE isn't found, the feature falls back to thumbnail-only diff (still useful).

**Implementation:**

```typescript
// electron/services/AssetDiffService.ts

interface AssetDiffRequest {
  repoPath: string
  filePath: string           // e.g. 'Content/Characters/Hero/SK_Hero.uasset'
  leftRef: string            // commit SHA or 'HEAD' or 'WORKING'
  rightRef: string           // commit SHA or 'HEAD' or 'WORKING'
}

interface AssetDiffResult {
  assetType: AssetType
  leftPreview: PreviewData   // PNG path, JSON data, or both
  rightPreview: PreviewData
  delta: AssetDelta          // type-specific structured diff
  renderedAt: Date
  cacheKey: string           // sha of leftRef+rightRef+filePath
}

type AssetDelta =
  | { kind: 'texture'; widthDelta: [number, number]; heightDelta: [number, number]; formatChanged: boolean; pixelDiffPath: string }
  | { kind: 'blueprint'; nodesAdded: BPNodeRef[]; nodesRemoved: BPNodeRef[]; nodesModified: BPNodeRef[]; connectionsChanged: number }
  | { kind: 'material'; parameterChanges: { name: string; before: any; after: any }[]; nodeGraphDelta: BPNodeDelta }
  | { kind: 'mesh'; vertsDelta: [number, number]; trianglesDelta: [number, number]; materialSlotsDelta: string[]; boundsDelta: BoundsDelta }
  | { kind: 'level'; actorsAdded: ActorRef[]; actorsRemoved: ActorRef[]; actorsMoved: { name: string; fromLoc: Vec3; toLoc: Vec3 }[] }
  | { kind: 'datatable'; rowsAdded: string[]; rowsRemoved: string[]; rowsChanged: { rowKey: string; columns: string[] }[] }
  | { kind: 'audio'; durationDelta: [number, number]; sampleRateDelta: [number, number]; waveformDiffPath: string }
  | { kind: 'generic'; metadataBefore: Record<string, any>; metadataAfter: Record<string, any> }

class AssetDiffService {
  async diff(req: AssetDiffRequest): Promise<AssetDiffResult>
  async renderThumbnail(repoPath: string, filePath: string, ref: string): Promise<string>  // returns PNG path
  async extractMetadata(repoPath: string, filePath: string, ref: string): Promise<Record<string, any>>
  async classifyAsset(repoPath: string, filePath: string): Promise<AssetType>
  clearCache(olderThanDays: number): Promise<void>
}
```

**Git plumbing for the "two versions" problem:**

To diff an asset at commit A vs commit B, Lucid Git needs both blobs on disk. It uses `git cat-file -p <ref>:<path>` to extract to a temp dir — cheap and doesn't touch the working tree. For LFS-tracked files, `git lfs smudge < /tmp/pointer` expands the pointer to the real binary. Results are cached by SHA so re-opening the same diff is instant.

**Caching:**
- Rendered PNGs stored in `~/.lucid-git/cache/asset-diffs/<repo-hash>/<left-sha>-<right-sha>/`
- Metadata JSON stored alongside
- LRU eviction at 5GB default (configurable in Settings)
- Cache key includes engine version — engine upgrade invalidates BP/material diffs

**UE commandlet wrapper:**

```typescript
// electron/services/UEHeadlessService.ts
class UEHeadlessService {
  async findEditorBinary(engineVersion: string): Promise<string | null>
  // Searches: Epic Games Launcher install paths, Registry (Win),
  // ~/Library/Application Support/Epic (Mac), user-configured override in electron-store

  async runCommandlet(args: {
    projectPath: string
    commandlet: 'DiffAssets' | 'DataTableCSVExporter' | 'ExportThumbnail'
    params: string[]
    timeoutMs: number
  }): Promise<CommandletResult>
  // Spawns UnrealEditor-Cmd with -run=<Commandlet>.
  // Persistent-process pool for warm invocations after first cold start.

  isEditorRunning(projectPath: string): boolean
  // If the user has the editor open, Lucid Git prompts rather than spawning
  // a second instance (UE locks the project file).
}
```

**UI — `AssetDiffViewer` component:**

- Replaces `BinaryDiff.tsx` when asset type is recognized
- Top bar: left-ref / right-ref picker, asset type badge, "Open in Unreal" button
- Main panel: split view appropriate to asset type (images side-by-side, BP node graph from commandlet JSON, mesh metadata table, actor diff list for levels, row diff for data tables, waveform for audio)
- Bottom strip: structured delta list with human-readable labels
- Loading state: "Starting Unreal Engine..." spinner while commandlet warms up
- Fallback banner: if UE isn't installed, engine version mismatches, asset is >500MB, or commandlet times out — show thumbnail + metadata only with a clear "UE diff unavailable — [reason]" banner. Never a blank panel.

**Graceful degradation:**
- No UE installed → thumbnail + metadata only (still better than stock Git)
- Engine version mismatch → thumbnail + metadata + warning banner
- Asset too large (>500MB) → metadata-only, no render attempted
- Legacy `.uasset` (UE4 format in UE5 repo) → metadata-only

**Where Lucid Git will NOT try to be clever:**
- We don't auto-merge binary assets. Ever.
- We don't write our own `.uasset` parser — that's a rabbit hole with no bottom. We use UE's own tooling.
- We don't try to diff Niagara systems visually at v1 (commandlet support is inconsistent). Fall back to metadata.

---

### 14. Dependency-Aware Blame

Stock `git blame` answers "who last touched this file?" That's useless for game dev, where a material breaking can be caused by any of its *referenced* assets being changed. Lucid Git answers "who last touched this asset **or any of its dependencies**?"

**Data source:**

Unreal writes an `AssetRegistry.bin` to `<Project>/Saved/Cooked/` after cooking, and to `<Project>/Intermediate/` during normal editor use. This is a binary-serialized index of all assets and their soft/hard references — the same data the editor's Reference Viewer uses.

Lucid Git reads this file directly. At v1 we implement a minimal reader that extracts just the `PackageName → [Referenced PackageNames]` map, using the schema documented in `Engine/Source/Runtime/AssetRegistry/`.

**If AssetRegistry isn't available:**

Fresh clone, never opened in editor → `AssetRegistry.bin` doesn't exist. Two fallbacks:
1. **Quick scan:** parse `.uasset` headers directly for the import table (`FPackageFileSummary` → walk `FObjectImport` entries). ~50x faster than a full load, gives us the reference graph without needing UE.
2. **Commandlet fallback:** run `UnrealEditor-Cmd -run=DumpAssetRegistry` to regenerate. Slow (2–10 min on a large project) but always works. Triggered only on user request.

**Implementation:**

```typescript
// electron/services/DependencyService.ts

interface DependencyGraph {
  nodes: Map<string, AssetNode>          // keyed by package name
  buildTime: Date
  engineVersion: string
  sourcePath: string                     // 'AssetRegistry.bin' | 'header-scan' | 'commandlet'
}

interface AssetNode {
  packageName: string                    // '/Game/Characters/Hero/BP_Hero'
  filePath: string                       // 'Content/Characters/Hero/BP_Hero.uasset'
  assetClass: string                     // 'Blueprint', 'Material', 'Texture2D', etc.
  hardReferences: string[]               // package names this asset hard-depends on
  softReferences: string[]
  referencedBy: string[]                 // reverse index (computed by Lucid Git)
}

interface DependencyBlame {
  targetAsset: string
  directBlame: GitBlameEntry
  dependencyBlames: DependencyBlameEntry[]
  suspects: SuspectRank[]
}

interface DependencyBlameEntry {
  dependencyPath: string
  hops: number                           // 1 = direct dep, 2 = dep-of-dep
  relationshipType: 'hard' | 'soft'
  lastCommit: { sha: string; author: string; email: string; date: Date; message: string }
  changedInLastNCommits: number          // churn signal
}

interface SuspectRank {
  path: string
  score: number                          // 0–100
  reasoning: string                      // e.g. "Changed 3 times this week, direct hard dependency"
}

class DependencyService {
  async buildGraph(repoPath: string, opts?: { maxDepth?: number; forceRebuild?: boolean }): Promise<DependencyGraph>
  // Priority: AssetRegistry.bin → header scan (worker_threads) → DumpAssetRegistry commandlet
  // Graph cached in SQLite keyed by repo + HEAD sha + engine version.
  // After git pull touching .uasset files: incremental re-scan of changed files only (debounced).

  async blameWithDependencies(repoPath: string, assetPath: string, opts?: {
    maxHops?: number      // default 2
    sinceDays?: number
  }): Promise<DependencyBlame>

  async findReferences(repoPath: string, assetPath: string): Promise<{ uses: string[]; usedBy: string[] }>
  // Powers the Reference Viewer panel

  async rankSuspects(blame: DependencyBlame): Promise<SuspectRank[]>
  // Scoring: recency 40% + hop-distance inverse 30% + churn frequency 20% + hard-vs-soft 10%
}
```

**Performance:**
- Graph build on a 50k-asset project: ~30–90s first time (parallelized worker scan), ~2s from SQLite cache
- Incremental update: re-scan only changed `.uasset` files after each pull, patch the graph in-place
- `better-sqlite3` adjacency list handles 100k+ nodes without issue
- Graph rebuild triggered automatically after `git pull` that touches `.uasset` files (debounced 2s)

**UI — `DependencyBlamePanel`:**

- Right-click any `.uasset` in the file tree → "Blame with dependencies"
- Top: standard git blame for the asset (author, date, commit message)
- Below: expandable dependency tree — each row shows path, hop count, last committer, date, and a churn badge (red if changed >3× in last 30 days)
- Suspect sidebar: top 5 ranked suspects with score bar and plain-English reasoning. Click → opens `AssetDiffViewer` for that asset
- "Reference Viewer" tab: force-directed neighborhood graph using `d3-force`. Nodes coloured by asset class. Capped at 200 nodes. Click a node → jump to that asset's blame panel.
- Loading state while graph builds: "Scanning 12,400 assets..." with live count

**Integration with Phase 10 commit graph:**

New "Dependency lens" button on the CommitGraph toolbar. When active and an asset is selected, every commit that changed that asset *or any of its dependencies* (up to 2 hops) is highlighted. All other commits are dimmed.

**Known limitations:**
- Soft references via runtime-computed `FSoftObjectPath` strings can't be statically resolved — rare in practice
- Blueprint interface calls: we see the interface reference, not the concrete implementer
- World Partition levels: handled via AssetRegistry, but cap neighborhood display at 200 nodes for large open worlds

---

### 15. Lock Heatmap & Conflict Forecasting

Two distinct features that share a data foundation. **Heatmap** is retrospective: where is the team contending? **Forecasting** is predictive: are you about to step on someone right now?

#### 15.1 Lock Heatmap (retrospective)

**What it shows:**

The project's asset tree visualized as a treemap, each cell color-graded by contention — a composite of lock frequency, mean lock duration, unique contributors, and merge conflict history.

**Data source — no new collection needed:**

The Section 2 lock poller already emits `EVT_LOCK_CHANGED` events. We persist every event to SQLite going forward. The Section 3 merge preview flow already detects conflicts; we persist those too.

```typescript
// electron/db/schema.sql additions
CREATE TABLE IF NOT EXISTS lock_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_path   TEXT    NOT NULL,
  file_path   TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  action      TEXT    NOT NULL,        -- 'lock' | 'unlock' | 'force-unlock'
  occurred_at INTEGER NOT NULL,        -- unix ms
  lock_duration_ms INTEGER             -- populated on unlock
);
CREATE INDEX idx_lock_events_path ON lock_events(repo_path, file_path, occurred_at);

CREATE TABLE IF NOT EXISTS conflict_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_path    TEXT    NOT NULL,
  file_path    TEXT    NOT NULL,
  detected_at  INTEGER NOT NULL,
  branches     TEXT    NOT NULL,       -- JSON: ['feature/a', 'main']
  conflict_type TEXT   NOT NULL,       -- 'content' | 'binary' | 'delete-modify'
  resolved     INTEGER NOT NULL        -- 0/1
);
```

**Implementation:**

```typescript
// electron/services/HeatmapService.ts

interface HeatmapCell {
  path: string
  isDirectory: boolean
  contentionScore: number           // 0–100
  lockEvents: number
  uniqueContributors: number
  meanLockDurationMs: number
  forceUnlocks: number
  conflictEvents: number
  topContributors: { user: string; events: number }[]
}

interface HeatmapRequest {
  repoPath: string
  windowDays: number                // default 30
  pathScope?: string                // narrow to 'Content/Characters/' etc.
  groupBy: 'file' | 'folder' | 'asset-type'
}

class HeatmapService {
  async computeHeatmap(req: HeatmapRequest): Promise<HeatmapCell[]>
  async getFileHistory(repoPath: string, filePath: string, windowDays: number): Promise<LockEvent[]>
  async getTopContendedAssets(repoPath: string, windowDays: number, limit: number): Promise<HeatmapCell[]>
}
```

**UI — `LockHeatmap` component:**

- Treemap via recharts `Treemap` — rectangle size = file count (folder) or 1 (file), color = contention score mapped from `--bg-elevated` (cold) → `--warning` (warm) → `--error` (hot)
- Toolbar: time-window selector (7d / 30d / 90d / All), group-by toggle (Folder | Asset Type)
- Click a folder cell → drill in to that folder. Click a file cell → open event timeline drawer
- Right sidebar: "Top 10 Contended" list with score bars and top contributor name
- Export to PNG for sprint reviews
- Accessible from sidebar nav and Settings → Team

**What producers use this for:**
- "Which asset is bottlenecked on one person?" → high lock duration, 1 unique contributor
- "Where should we split a system?" → folders with high contention across many users
- "Why do we keep conflicting here?" → conflict-event overlay answers directly

#### 15.2 Conflict Forecasting (predictive)

**What it warns about:**

Before editing a file, Lucid Git checks whether a conflict is already brewing:
- A teammate has it locked right now (Section 2 — already done)
- A teammate has **commits touching it on a remote branch** that aren't in your branch yet (Path A — detectable, no opt-in)
- A teammate is **actively working on it right now** (Path B — opt-in WIP sharing)

**Path A — Remote branch divergence (default on, no opt-in):**

Background `git fetch --all` every 5 min (configurable). After each fetch, diff remote branch tips vs HEAD per file. If `feature/alex-hero-rework` has commits touching `SK_Hero.uasset` that aren't merged into your branch yet — warn before you start editing.

**Path B — Live WIP sharing (opt-in, default OFF):**

Users optionally publish a list of file paths they're currently modifying — paths only, never contents. Published to a GitHub Gist, a dedicated `lucid-git-presence` branch (single-writer-per-user, force-pushed), or a Discord webhook channel. Default OFF with a plain-English privacy explanation shown before first enable.

**Implementation:**

```typescript
// electron/services/ForecastService.ts

interface ForecastWarning {
  path: string
  severity: 'info' | 'warning' | 'blocker'
  reasons: ForecastReason[]
}

type ForecastReason =
  | { type: 'locked-by-other'; user: string; since: Date }
  | { type: 'unpushed-remote-commits'; branch: string; author: string; commitCount: number; lastCommit: Date }
  | { type: 'teammate-has-uncommitted'; user: string; since: Date; source: 'gist' | 'presence-branch' | 'webhook' }
  | { type: 'high-contention'; heatmapScore: number }
  | { type: 'recently-conflicted'; lastConflict: Date; count: number }

class ForecastService {
  async forecastForFile(repoPath: string, filePath: string): Promise<ForecastWarning>
  async forecastForWorkingTree(repoPath: string): Promise<ForecastWarning[]>

  startRemotePoll(repoPath: string, intervalMs: number): void
  stopRemotePoll(repoPath: string): void

  async publishWIP(repoPath: string, filePaths: string[], destination: WIPDestination): Promise<void>
  async fetchTeammateWIP(repoPath: string, source: WIPDestination): Promise<TeammateWIP[]>
  // Paths only — no file contents ever transmitted
}

type WIPDestination =
  | { kind: 'gist'; gistId: string; visibility: 'secret' | 'public' }
  | { kind: 'presence-branch'; branch: string }
  | { kind: 'webhook'; url: string }

interface ForecastConfig {
  enabled: boolean
  remotePollIntervalMs: number        // default 300000 (5 min)
  wipSharingEnabled: boolean          // default false
  wipDestination?: WIPDestination
  warnOnHighContention: boolean
  contentionThreshold: number         // 0–100, default 60
  quietHours?: { start: string; end: string }
}
```

**UI:**

- File tree rows: warning icon column, coloured by max severity. Hover tooltip lists reasons in plain English.
- OS file watcher: when a file transitions to modified, call `forecastForFile()` and toast if severity ≥ warning. "⚠️ Alex has commits on feature/hero-rework touching this file."
- Forecast Panel in sidebar: live list of modified files with active warnings, sorted by severity
- Pre-commit check: when staging, re-run `forecastForWorkingTree()` on staged files. If any blockers, show confirmation dialog — never silently block.
- Settings → Team → Forecasting: poll interval, WIP sharing toggle (privacy explanation shown inline before enable), destination picker, contention threshold, quiet hours

**Honest limitations:**
- Path B misses teammates who don't use Lucid Git or have WIP sharing off — Path A (post-push) still works for them
- Remote poll costs bandwidth; 5-min interval on a 10-person team is negligible but configurable
- WIP sharing is cooperative, not enforcement — a user who opts out is simply invisible to Path B

---

### 16. Role-Based Access Control

Lucid Git maps GitHub repository collaborator permissions to two tiers that gate which features are available in the UI and enforced in the main process.

**Why two tiers, not three:**

GitHub exposes `admin`, `maintain`, `write`, `triage`, `read`. In practice, any user below `push` (write) is already blocked by GitHub from pushing commits, so Lucid Git only needs to distinguish admin from everyone-with-write-access. `maintain` is treated as `write` — it has some branch management powers on GitHub, but Lucid Git's admin gate is specifically about destructive and team-wide config operations.

**Permission source:**

```typescript
// On repo open: GET https://api.github.com/repos/{owner}/{repo}
// Response includes: { permissions: { admin, maintain, push, triage, pull } }
// Mapping:
//   permissions.admin === true  → 'admin'
//   permissions.push  === true  → 'write'
//   else                        → 'read'  (shouldn't reach Lucid Git, but handled)
```

For GitHub Enterprise repos: extract the API host from the git remote URL (e.g. `git@github.mycompany.com:...` → `https://github.mycompany.com/api/v3/repos/...`). User-configurable API host override in Settings → Accounts for edge cases.

**Permission cache:**

Stored in `electron-store` under `permissionCache`, keyed by `"{owner}/{repo}"`:
```typescript
interface PermissionCacheEntry {
  permission: RepoPermission
  fetchedAt: number   // unix ms
}
```
TTL 5 minutes (configurable). Refreshed on repo open, after login, and on manual refresh (right-click permission badge in status bar). Cached value is used optimistically while a background refresh runs.

**Fail-open behavior:**

If the API call fails for any reason (network error, GHE without API configured, rate-limit), Lucid Git defaults to `write` — never locks users out. A warning badge appears in the top bar: "Permission check unavailable — operating in collaborator mode." Users can still access all write-access features.

**Defense in depth:**

Permission is checked at two layers:
1. **Renderer** — UI elements are dimmed and disabled with a lock icon. Clicking shows a tooltip: "This action requires repository admin access."
2. **Main process** — IPC handlers for admin-gated operations call `permissionService.isAdmin(repoPath)` before executing. If not admin: returns `{ code: 'PERMISSION_DENIED', title: 'Admin access required', ... }`. This prevents renderer bypass.

**Admin-only operations:**

| Operation | Service / Location |
|---|---|
| Force-unlock another user's file | `LockService.unlockFile(..., force=true)` |
| Delete remote branch | `GitService.deleteRemoteBranch()` |
| Delete local branch with `-D` (force) | `GitService.deleteBranch(name, force=true)` |
| Hard reset (`--hard`) | `GitService.resetTo()` with `hard` mode |
| LFS history migration (rewrites history) | `GitService.lfsMigrate()` |
| Repo cleanup (gc, prune, shallow) | `CleanupService.*` — all methods |
| Write `.gitattributes` team-wide | `UnrealService.writeGitattributes()` |
| Write `.gitignore` | `UnrealService.writeGitignore()` |
| Write UE editor/engine `.ini` config | `UnrealService.writeEditorConfig()`, `writeEngineConfig()` |
| Set `lfs.locksverify` git config | `GitService.setGitConfig(repoPath, 'lfs.locksverify', ...)` |
| Install/modify team hooks | `HookService` install actions |
| Export / save `team-config.json` | Team Config panel write actions |
| Configure team Discord webhooks | Webhook settings save |

**Write-access operations (all authenticated collaborators):**

Commit, push, pull, fetch, create/rename/checkout branches, stash, cherry-pick, revert, standard merge, lock/unlock own files, LFS track patterns (personal), view diffs/history/blame/heatmap/forecast, personal settings, link GitHub identity, view (not modify) admin-gated panels.

**UI conventions:**

- Never hide admin features from write-access users — dim and disable them. Hiding confuses users who don't know a feature exists.
- For entirely admin-only panels (Cleanup, Team Config, Webhook settings): show a persistent read-only banner: "You are viewing as a Collaborator. Repository admin access is required to modify these settings."
- Status bar: subtle "Admin" or "Collaborator" badge next to the repo name. Clicking shows a popover with a brief explanation of what each tier means. While fetching: "Checking permissions..." spinner.
- Top bar: warning badge on permission fetch failure (network error, GHE misconfiguration). Clicking it opens a dialog explaining the fallback behavior.

**Trigger points for permission refresh:**

1. Repo open / repo switch
2. After successful auth login
3. Manual refresh (right-click status bar permission badge)
4. After receiving `PERMISSION_DENIED` from main process (race condition guard)

---

### 17. Dashboard Panel

Every user's default landing panel when the app opens. Replaces the raw Overview screen as the home for day-to-day use. Overview is relocated to the Admin group in the sidebar.

**Header:**
- Personalized greeting: "Good morning / afternoon / evening, {firstName}" derived from system clock and the user's GitHub login
- Branch name + repository name shown below the greeting in monospace
- Refresh button top-right to manually re-fetch sync status and activity

**Stale-pull warning banner (conditional):**
Shown when `behind > 0` AND the last recorded pull was more than 2 days ago (or has never happened). Displays commit count, last-pulled time, and a "Pull" button. The Pull button is disabled until `hasFetched` (consistent with all other Pull buttons). Timestamp persisted to `localStorage` keyed `lucid-git:last-pull:{repoPath}`.

**Daily Flow Strip:**
A horizontal 3-step guide spanning the full width. Each step has a numbered/check badge, label, status sub-text, and an optional action button. Steps and their states:

| Step | Label | State logic | Buttons |
|---|---|---|---|
| 1 | Sync | warn if behind; action if ahead; done if clean | **Fetch** (always enabled when not busy) + **Pull** (enabled only after a Fetch has been performed this session; amber when `behind > 0 && hasFetched`) |
| 2 | Work & Commit | action if staged/modified files exist; done if clean | "View Changes" — navigates to the Changes panel |
| 3 | Open PR | neutral always | "Create PR" — opens GitHub compare URL in browser; absent if no GitHub remote detected |

Step 1 renders two `SmallBtn` components side-by-side. `hasFetched` is tracked via the module-level `sessionFetchedRepos: Set<string>` and `localStorage` key `lucid-git:last-fetch:{repoPath}`. Pull is disabled (`disabled={isBusy || !hasFetched}`) until at least one Fetch has completed in the current session. `doPull()` calls `ipc.pull()` directly — it does **not** internally fetch first; Fetch is always an explicit user action.

Step sub-text wraps freely; no text is truncated with ellipsis. Fetch timestamp recorded to `lucid-git:last-fetch:{repoPath}`; pull timestamp to `lucid-git:last-pull:{repoPath}`.

**3-column status grid:**
Three cards displayed side-by-side below the flow strip:
- *Sync Status* — upstream tracking ref, ahead/behind counters, three buttons: **Fetch** (always active), **Pull** (disabled until `hasFetched`; amber when behind), **Push** (disabled until `hasFetched && behind === 0 && ahead > 0`)
- *Current Changes* — staged/modified counts, preview of up to 6 changed files with status badges, "View All" link
- *Active Locks* — per-lock avatar + filename + owner + time held; "YOU" badge for own locks; overflow count

**Suggestions card (full width):**
A time-aware advice panel. Each suggestion is a colored card with a dot indicator and plain-prose text (no truncation). Urgency tiers and their trigger conditions:

| Urgency | Color | Trigger |
|---|---|---|
| ok (green) | Synced within last 4 hours | — |
| tip (blue) | Synced 4–8 hours ago, or time-of-day tip | No action button |
| warn (amber) | Synced 8–24 hours ago | Sync button shown |
| high (orange) | Never synced this session | Sync button shown |
| critical (red) | Last sync ≥ 2 days ago | Sync button shown |

Time-of-day tips: morning (5am–12pm) suggests fetching and pulling if last sync > 1 hour ago; evening (5pm–10pm) suggests committing + pushing if there are unpushed commits or uncommitted changes.

**Activity card (full width):**
Shows the 12 most recent entries from `gitBranchActivity`. Each entry displays: author avatar (colored initials), commit message (full text, wraps naturally — no ellipsis), branch pill (colored by author), author name, and time-ago. "Full History →" navigates to the History panel.

---

### 18. Admin Role Preview

An extension to the RBAC system (Section 16) that lets admins temporarily simulate how the app looks and behaves for lower-permission roles — useful for verifying that access gates and banners work correctly before distributing to the team.

**State:**
`viewAsRole: RepoPermission | null` added to `authStore`. When `null`, the real permission applies. When set to `'write'` or `'read'`, `isAdmin(repoPath)` returns `false` even for a real admin.

```typescript
// authStore — updated isAdmin selector
isAdmin: (repoPath: string) => {
  if (get().repoPermissions[repoPath] !== 'admin') return false
  const override = get().viewAsRole
  return override === null || override === 'admin'
}
```

**Activation:**
In StatusBar, the "Admin" badge is clickable for real admins. Clicking opens a dropdown above the status bar labeled "PREVIEW AS ROLE" with three options: Admin (default), Collaborator (`write`), Read-only (`read`). Selecting a non-admin role sets `viewAsRole`.

**Indication:**
A purple banner is injected in TopBar when `viewAsRole` is set:
> "Previewing as Collaborator — admin features are restricted. [Switch back to Admin]"

The "Switch back to Admin" button clears `viewAsRole`. The status bar badge turns purple and shows the active preview role name.

**Reactivity:**
Because all components gate on `useAuthStore(s => s.isAdmin(repoPath))`, switching preview role instantly updates the entire UI — admin buttons dim, admin banners appear — without any reload.

**Scope:**
Preview mode is session-only and stored only in memory. It does not persist across app restarts. Main-process IPC guards are not affected by `viewAsRole`; only the UI layer reflects the preview.

---

### 19. Custom Dialog System

All native OS dialogs (`window.confirm`, `window.alert`, `window.prompt`, and direct `confirm()` calls) are replaced by a theme-consistent in-app modal system. This eliminates the jarring mismatch between the app's dark UI and the operating system's default dialog chrome.

**Architecture:**
- `src/stores/dialogStore.ts` — Zustand store with Promise-based imperative API. Any component can `await dialog.confirm(opts)` without rendering its own modal.
- `src/components/ui/GlobalDialogs.tsx` — top-level renderer mounted in AppShell that reads `dialogStore.pending` and renders the appropriate modal. Mounted once; always visible.

**Store API:**
```typescript
dialog.confirm(opts: ConfirmOpts): Promise<boolean>
dialog.prompt(opts: PromptOpts): Promise<string | null>
dialog.alert(opts: AlertOpts): Promise<void>
dialog.settle(value): void   // called by modal buttons to resolve the pending promise
```

If a dialog is already shown when a new request arrives, the new request is immediately resolved with `false` / `null` to prevent stacking.

**Modal anatomy:**
- Fixed full-screen backdrop: `rgba(0,0,0,0.6)` with `backdrop-filter: blur(3px)`, z-index 600
- Panel: `var(--lg-bg-elevated)` background, 12px border-radius, `var(--lg-border)` border, drop shadow, `slide-down` entrance animation (reuses the keyframe already defined in `index.css`)
- Title, optional message, optional detail text
- Cancel button (transparent, border on hover) + Confirm button (filled with danger=red / normal=accent color)
- Keyboard: Escape = cancel/close; Enter = confirm (via autoFocus on confirm button)
- PromptModal: autofocused text input with accent-colored focus ring; Enter in input = confirm

**Danger mode:**
`ConfirmOpts.danger: true` colors the confirm button red and prepends a warning triangle icon.

**Usage across the codebase:**
Replaces native dialogs in: `CommitBox` (bypass pre-commit hook), `FileTree` (discard all, stash), `FileRow` (discard, force unlock, ignore), `LfsPanel` (untrack, migrate history), `BranchPanel` (delete local branch, delete remote branch).

---

### 20. Navigation & Sidebar Redesign

The left sidebar is rebuilt around three collapsible navigation groups and a persistent bottom toolbar.

**Navigation groups:**

| Group | Items | Visibility |
|---|---|---|
| Workspace | Dashboard, Changes, History, Branches | Always visible |
| Tools | Tools, Team, Content Browser, File Map, Heatmap, Forecast | Always visible |
| Admin | LFS, Cleanup, Unreal, Hooks, Overview | Only when `isAdmin(repoPath)` is true and a repo is open |

Each group header is a clickable button with a chevron icon that rotates 90° when collapsed. Collapsed state is persisted to `localStorage` under the key `lucid-git:sidebar-groups` as a JSON object keyed by group key. In icon-only (narrow) sidebar mode, all items are always shown regardless of collapse state.

When no repository is open, nav items render at 30% opacity with `cursor: default` — they are visible but not interactive.

**Bottom toolbar:**
Four permanent action buttons pinned to the bottom of the sidebar, outside any scroll container:

| Button | Action | Accent |
|---|---|---|
| Settings | Navigate to settings panel; highlights when active | Default |
| View in Explorer | `ipc.showInFolder(repoPath)` | Default |
| Open Terminal | `ipc.openTerminal(repoPath)` | Default |
| Switch Repository | Opens the repository picker | Accent orange on hover |

The Switch Repository button uses a custom `SwitchRepoIcon` (folder-with-arrow SVG) and is the primary affordance for multi-repo workflows.

---

### 21. Asset Viewer Panel

A right-side overlay panel that opens when a user clicks any file thumbnail in the Changes panel or selects "Preview file" from the context menu. Provides thumbnail preview with zoom controls, fullscreen toggle, and a scrollable version history strip — similar in spirit to Anchorpoint's asset viewer.

**State:**
`useAssetViewerStore` (Zustand) holds `{ repoPath, filePath, isOpen, open(repoPath, filePath), close() }`. Any component can call `open()` to surface the panel for a given file.

**Panel anatomy:**

- Positioned `absolute; top:0; right:0; bottom:0; width:400px` inside `<main>` (which is `position:relative`), so it overlays the current panel without pushing content.
- **Header:** filename, SHA badge (shown when viewing a historical version), fullscreen toggle (expands to full `<main>` width), close ×.
- **Preview area:** checkerboard background for transparency, `<img>` scaled via `transform: scale(zoom)`. Supports image formats and UE asset thumbnails. Shows loading spinner while fetching, empty-state SVG for unsupported types.
- **Zoom controls:** − / + / Fit buttons + percentage readout. "← Current" button returns from a historical ref back to the working tree version.
- **Version history strip:** horizontal scroll strip at the bottom. Loads up to 20 commits via `ipc.gitFileLog(repoPath, filePath, 20)`. Each card (~68px wide) shows the commit thumbnail via `ipc.assetRenderThumbnail(repoPath, filePath, commit.hash)`, commit hash short form, and author. Clicking a card sets `selectedRef` to that commit hash, loading that historical version in the preview.

**Trigger points:**
- Clicking the thumbnail button in `FileRow` (Changes panel) for any image or UE asset file.
- "Preview file" context menu item on previewable files in `FileRow`.

**File type detection:**
`isImgAsset` covers standard image extensions; `isUEAsset` covers `.uasset`, `.umap`, and related UE formats. `isPreviewable = isUEAsset || isImgAsset`.

---

### 22. Global Tooltip System

A portal-based tooltip component that replaces native `title` attributes across the entire app. Uses `ReactDOM.createPortal` to render into `document.body`, avoiding clipping from any `overflow:hidden` ancestor (such as the collapsed sidebar `<aside>`).

**API:**
```tsx
<Tooltip content="Settings" side="right" delay={300}>
  <NavBtn ... />
</Tooltip>
```

- `side?: 'top' | 'right' | 'bottom' | 'left'` — default `'top'`
- `delay?: number` — show delay in ms, default 500ms
- Wrapper `<span>` uses `display: 'contents'` so it has no layout impact on the child

**Positioning:**
On mouse-enter, reads `wrapRef.current.getBoundingClientRect()` and computes `position:fixed` coordinates for the tooltip portal. This ensures correct placement regardless of scroll or nested overflow containers.

**Applied across:**
- Sidebar nav buttons (collapsed icon-only mode shows tooltip with nav item label, side `'right'`, 300ms delay)
- All bottom toolbar buttons in the sidebar when collapsed
- Other interactive icons throughout the app

---

### 23. Panel Error Boundary

A React class component (`PanelErrorBoundary`) wrapping every routed panel in `AppShell`. Catches render-time errors in any panel and shows an in-app recovery UI instead of crashing the entire window.

**Props:** `tabId: string`, `onGoHome: () => void`

**Behavior:**
- On error: shows an error icon, the error message in monospace, a "Try again" button (clears error state), and a "Return to Dashboard" button (calls `onGoHome` which sets `leftTab` to `'dashboard'`).
- On tab change (`componentDidUpdate` comparing `tabId`): automatically clears error state so navigating away and back gets a fresh render.

**Coverage:** All panel routes in `AppShell` are individually wrapped, including both sides of the split-panel view. The `<main>` element holds `position:relative` to accommodate the `AssetViewerPanel` overlay; the error boundary sits inside each panel slot, not around `<main>` itself.

---

## Design System

**Aesthetic:** Industrial/utilitarian dark theme. Heavy-duty tool for serious teams.

```css
--bg-primary: #0d0f14;
--bg-secondary: #13161e;
--bg-elevated: #1a1e2a;
--accent: #e85d2f;           /* accent orange */
--accent-secondary: #4a9eff; /* steel blue */
--success: #2dbd6e;
--warning: #f5a623;
--error: #e84040;
--text-primary: #e8eaf2;
--text-secondary: #8892a4;
--lock-mine: #2dbd6e;
--lock-other: #e85d2f;
--border: #252a38;
```

**Typography:** JetBrains Mono (display) + IBM Plex Sans (UI)

**Layout:** 3-panel (sidebar / main / detail), collapsible, Cmd+K command palette

---

## package.json (concrete, verified versions — April 2026)

```json
{
  "name": "lucid-git",
  "version": "0.1.0",
  "main": "dist-electron/main.js",
  "scripts": {
    "dev": "concurrently \"vite\" \"electron .\"",
    "build": "tsc -p tsconfig.main.json && vite build",
    "package": "npm run build && electron-builder",
    "release": "npm run build && electron-builder --publish always",
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --ext ts,tsx"
  },
  "dependencies": {
    "dugite": "^3.2.1",
    "keytar": "^7.9.0",
    "better-sqlite3": "^11.0.0",
    "electron-store": "^10.0.0",
    "electron-updater": "^6.3.0",
    "zustand": "^5.0.0",
    "@tanstack/react-query": "^5.59.0",
    "@tanstack/react-virtual": "^3.10.0",
    "p-queue": "^8.0.1",
    "date-fns": "^4.1.0",
    "lucide-react": "^0.454.0",
    "@monaco-editor/react": "^4.6.0",
    "recharts": "^2.13.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "tailwind-merge": "^2.5.0",
    "clsx": "^2.1.0",
    "cmdk": "^1.0.0",
    "sharp": "^0.33.0",
    "d3-force": "^3.0.0",
    "fluent-ffmpeg": "^2.1.3"
  },
  "devDependencies": {
    "electron": "^33.0.0",
    "electron-builder": "^25.0.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "@vitejs/plugin-react": "^4.3.0",
    "tailwindcss": "^3.4.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "concurrently": "^9.0.0",
    "eslint": "^9.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/d3-force": "^3.0.0",
    "@types/fluent-ffmpeg": "^2.1.26",
    "@playwright/test": "^1.48.0"
  }
}
```

---

## Claude Code Implementation Order

### Phase 0 — Preflight
Claude Code should confirm with you:
- GitHub OAuth App Client ID (from github.com/settings/developers)
- GitHub org/repo where Lucid Git source + releases will live
- macOS code-signing: set up now or defer

### Phase 1 — Scaffold + IPC contract
- Electron + Vite + React + TypeScript
- Tailwind + shadcn/ui setup
- Define all `CHANNELS` and the full typed IPC surface in `src/ipc.ts` **before any features**
- `electron-builder.yml` skeleton
- Bare 3-panel layout

### Phase 2 — dugite + GitService skeleton
- Install dugite; verify `exec(['--version'], cwd)` works
- GitService: clone, status, stage, unstage, commit, push, pull, fetch
- Wire through IPC
- Stderr progress parsing

### Phase 3 — Auth (Device Flow)
- AuthService + device flow
- keytar integration
- Login screen + account switcher

### Phase 4 — File tree + status + basic diff
- FileTree + staging
- Monaco TextDiff + BinaryDiff
- CommitBox

### Phase 5 — Locking + lock notifications
- LockService + poller
- Lock badges
- "Watch file" → unlock notifications
- In-app notification bell + feed

### Phase 6 — Merge preview + conflict resolution
- `mergePreview` via `merge-tree`
- ConflictPreview UI with contributor cards
- TextResolver + BinaryResolver

### Phase 7 — LFS manager + auto-detect
- LFSService
- Large-file scan + migration UI

### Phase 8 — Cleanup + shallow clone + size dashboard
- CleanupService (gc, prune, lfs-prune)
- ShallowCloneManager
- Size dashboard with recharts

### Phase 9 — Discord webhooks + notification settings
- NotificationService webhook posting via p-queue
- Webhook settings UI + test button
- Per-event toggles + quiet hours

### Phase 10 — History graph + restore
- `git log --graph` parser
- CommitGraph canvas render
- Restore-to-commit with safety branch

### Phase 11 — Unreal features
- `.uproject` detection
- `.gitattributes` + `.gitignore` editors
- Pak size estimator
- Check-out-for-edit workflow

### Phase 12 — Pre-commit hooks UI

### Phase 13 — Error resolution polish
- Full 14-code library wired through UI
- Auto-fix dispatchers

### Phase 14 — Distribution + auto-update
- Finalize electron-builder
- GitHub Actions release workflow
- Test installers on all three platforms
- Auto-updater UI

### Phase 15 — Settings, command palette, final polish

### Phase 16 - using UEGitPlugin (GitSourceControl.uplugin)
For UE5 integration, we're integrating with the ProjectBorealis UEGitPlugin
(https://github.com/ProjectBorealis/UEGitPlugin), which is an open-source
UE source control provider that uses the same Git LFS locks Lucid Git uses.

1. UProjectDetector: detect if a .uproject exists in the repo root. If so,
   enable all UE-related features.

2. Plugin installer UI: check if Plugins/UEGitPlugin/GitSourceControl.uplugin
   exists. If not, show a prominent banner:
  "Please get the plugin folder"

3. Auto-config writer (opt-in): offer to write the recommended settings
   from the plugin README into the user's Config/ .ini files:
   - DefaultEditorPerProjectUserSettings.ini: bSCCAutoAddNewFiles=False,
     bAutomaticallyCheckoutOnAssetModification=True,
     bPromptForCheckoutOnAssetModification=False,
     bAutoloadCheckedOutPackages=True
   - DefaultEngine.ini: r.Editor.SkipSourceControlCheckForEditablePackages=1
   Write with clear comments explaining each setting; preserve existing
   content in these files.

4. .gitattributes: use the PB-style explicit per-extension format matching
   https://github.com/ProjectBorealis/PBCore/blob/main/.gitattributes
   (NOT a generic Content/** wildcard — the plugin README explicitly
   requires explicit file attributes for *.umap and *.uasset).

5. Identity linker: after GitHub auth, write the user's GitHub username
   into the UE plugin's LFS name configuration so locks made in UE are
   attributed correctly and match locks made in Lucid Git.

6. Lock status reconciliation: Lucid Git's lock poller already reads all
   LFS locks from the remote. No changes needed — both tools share the
   same lock backend, so locks made in UE appear in Lucid Git's UI
   automatically on the next poll.

The built plugin will be placed within the "plugins" folder

### Phase 17 — Binary Asset Diff Previews
- `UEHeadlessService`: locate `UnrealEditor-Cmd` across Epic Launcher paths, Windows registry, macOS `~/Library` paths, and a user-configurable override in `electron-store`. Persistent-process pool for warm commandlet invocations after first cold start. `isEditorRunning()` guard to avoid spawning a second UE instance.
- `AssetDiffService`: `classifyAsset()` by extension + UE header sniff; `git cat-file -p <ref>:<path>` extraction to temp dir for both blob sides (LFS pointer smudge for LFS-tracked files); per-type renderers — textures via `sharp`, Blueprints/Materials/Levels via `DiffAssets` commandlet, Data Tables via `DataTableCSVExporter`, audio waveforms via `fluent-ffmpeg` (optional — degrade gracefully if missing), video thumbnails via `fluent-ffmpeg`
- LRU PNG + JSON cache at `~/.lucid-git/cache/asset-diffs/`, keyed by commit SHAs + engine version, 5GB cap
- `AssetDiffViewer` component replacing `BinaryDiff.tsx` for recognised asset types — split view, structured delta list, "Open in Unreal" button, "Starting Unreal Engine..." loading state, explicit fallback banner when UE is unavailable
- Add `sharp` to `asarUnpack` in `electron-builder.yml`

### Phase 18 — Dependency-Aware Blame
- `DependencyService`: graph building with three source priority — `AssetRegistry.bin` parser (primary), parallelised `.uasset` header scan via `worker_threads` (fallback), `DumpAssetRegistry` commandlet (last resort). SQLite adjacency list cache keyed by repo + HEAD sha + engine version. Incremental re-scan on pull (debounced).
- `blameWithDependencies()`: standard `git blame` on the target + `git log -1` per dependency up to `maxHops` (default 2). Churn computed from commit count in `sinceDays` window.
- `rankSuspects()`: recency 40% + hop-distance inverse 30% + churn 20% + hard-vs-soft 10%
- `DependencyBlamePanel`: direct blame at top, expandable dependency tree with churn badges, suspect sidebar (click → `AssetDiffViewer`), Reference Viewer tab with `d3-force` neighborhood graph (cap 200 nodes)
- Phase 10 commit graph "Dependency lens": highlights commits touching the selected asset or its dependencies (2-hop)

### Phase 19 — Lock Heatmap & Conflict Forecasting
- SQLite `lock_events` and `conflict_events` tables via `migrations.ts`. Backfill: wire Section 2 lock poller to write every future lock/unlock/force-unlock event; wire Section 3 merge preview to write every detected conflict.
- `HeatmapService.computeHeatmap()`: contention score from lock frequency 35% + mean duration 25% + unique contributors 25% + conflict count 15%, normalised 0–100
- `LockHeatmap` component: recharts `Treemap` with cold→warm→hot colour gradient, time-window selector (7d / 30d / 90d / All), group-by toggle (Folder | Asset Type), click-to-drill-down, event timeline drawer per file, "Top 10 Contended" sidebar, PNG export
- `ForecastService` Path A (default on): background `git fetch --all` poller, per-file diff of remote branch tips vs HEAD, `EVT_FORECAST_CONFLICT` events for files you've modified that have remote branch activity
- `ForecastService` Path B (opt-in, default OFF): `publishWIP()` / `fetchTeammateWIP()` to GitHub Gist / presence branch / webhook — file paths only, never contents. Privacy explanation shown inline before first enable.
- File tree warning icons + hover tooltips, forecast toast on file-open, `ForecastPanel` sidebar, pre-commit re-check with confirmation dialog (never silent block)
- Settings → Team → Forecasting page: poll interval, WIP sharing toggle + privacy copy, destination picker, contention threshold, quiet hours

### Phase 20 — Role-Based Access Control

- **`PermissionService`** (`electron/services/PermissionService.ts`): extract owner/repo from `git remote get-url origin`; call GitHub API `/repos/{owner}/{repo}`; map `permissions.admin` → `'admin'`, `permissions.push` → `'write'`; cache in `electron-store` with timestamp; detect GHE host from remote URL; fail-open to `'write'` on any network error
- **New IPC channels** in `electron/ipc/channels.ts`: `AUTH_FETCH_REPO_PERMISSION`, `AUTH_GET_REPO_PERMISSION`
- **Handler registration** in `electron/ipc/handlers.ts`: wire new channels to `PermissionService`; add `permissionService.isAdmin(repoPath)` guard before executing admin-gated handlers: `lock:unlock` (force), `git:branch-list` delete, `git:reset` hard, `lfs:migrate`, `cleanup:*`, `ue:write-*`, `webhook:save`, team config save, hook install
- **`electron/types.ts`**: add `type RepoPermission = 'admin' | 'write' | 'read'` and `RepoPermissionCache` interface
- **`src/stores/authStore.ts`**: add `repoPermissions: Record<string, RepoPermission>`, `fetchRepoPermission(repoPath)` action, `isAdmin(repoPath)` selector
- **`src/ipc.ts`**: expose `fetchRepoPermission` and `getRepoPermission` typed wrappers
- **`src/components/layout/StatusBar.tsx`**: permission tier badge ("Admin" / "Collaborator" / spinner); right-click context menu with "Refresh permissions"
- **`src/components/layout/TopBar.tsx`**: warning badge when permission fetch failed; click to open explanation dialog
- **`src/components/settings/SettingsPage.tsx`**: read-only collaborator banner on admin-only tabs (Cleanup, Team, Webhooks)
- **`src/components/changes/FileRow.tsx`**: dim force-unlock option with lock icon for non-admins
- All admin-gated action buttons across UI: wrap with an `AdminGate` pattern — renders button dimmed + lock icon when `!isAdmin(repoPath)`, shows tooltip on click
- Fetch permission on repo open (`repoStore` repo change effect) and after login

---

---

### 24. Admin Overview Improvements, PR Resolve Dialog, Sync Buttons, Account Menu & Session Restore

A group of UX improvements shipped together. All changes are confined to existing files — no new panels or stores.

---

#### 24.1 Admin Overview Layout

**PR Management moved to the top.**
`AdminPRsCard` is now rendered immediately below the health-status strip and warnings, before the LFS Health / Repository Size row. Pull requests are the highest-priority admin action and should be the first thing visible.

**Commits and Activity at matching heights.**
Both `CommitsCard` and `ActivityCard` use a shared `COMMITS_HEIGHT = 340` constant for their scrollable content area (content div, not including the 34px card header). Both cards have `height: COMMITS_HEIGHT + 34` set on the outer card. Content overflows via `overflowY: 'auto'`, so either card scrolls independently once items exceed 340px. Commit fetch limit raised from 10 to 20 to take advantage of the scroll.

---

#### 24.2 PR Resolve Dialog

Each PR row in `AdminPRsCard` now shows a single **Resolve** button (replaces the old Merge + Decline pair). Clicking it opens `ResolveDialog`, a modal (z-index 600, blur backdrop, `slide-down` animation) with the following structure:

**Header:** PR number badge, title, close ×.

**Branch info strip:** `headBranch → baseBranch · by author`.

**Action toggle:** two full-width buttons — `✓ Accept (Merge)` and `✕ Decline (Close)`. Mutually exclusive; toggling between them is instant.

**Accept flow — conflict preview:**
When Accept is active, the dialog calls `ipc.mergePreview(repoPath, pr.headBranch)` on mount (and on toggle). While loading, shows "Checking for conflicts…". If no conflicts: `✓ No merge conflicts detected`. If conflicts exist, shows a count header and a scrollable list of conflicting files. Each file card offers two buttons:
- `Accept from {headBranch}` — adopts the incoming change (theirs); defaults on
- `Accept from {baseBranch}` — keeps the current base (ours)

The contributor name and last-edit date are shown under each option, sourced from `ConflictPreviewFile.theirs` / `.ours`. Per-file choices are stored in local state (`fileChoices: Record<string, 'branch' | 'base'>`); the dialog records the user's intent but the final merge is executed via the GitHub API.

**Decline flow:** Shows a plain warning box explaining the PR will be closed without merging; the branch remains intact.

**Footer:** Cancel (no-op) + Confirm. Confirm label changes contextually: "Merge PR" / "Close PR". On confirm:
- Accept → `ipc.githubMergePR({ owner, repo, prNumber })`
- Decline → `ipc.githubClosePR({ owner, repo, prNumber })`

Both calls go through `operationStore.run(…)` for progress tracking. On success, calls `onDone()` (triggers PR list refresh) then `onClose()`.

---

#### 24.3 TopBar Sync Buttons

The previous single smart split-button (Fetch / Pull / Push contextual with a chevron dropdown) is replaced by **two explicit buttons**, always visible when a repo is open:

| Button | Label | Behavior |
|---|---|---|
| Fetch & Pull | "Fetch & Pull" / "Fetching…" / "Pulling…" | Always fetches first via `ipc.fetch(repoPath)`. After the fetch resolves, re-reads sync status; if `behind > 0`, automatically executes `ipc.pull(repoPath)`. Calls `refreshStatus()` and `onSynced?.()` after pull. This guarantees the user always fetches before any pull. |
| Push | "Push" / "Pushing…" | Calls `ipc.push(repoPath)`. |

**State:** Both buttons share the same `syncOp` state (`'idle' | 'fetching' | 'pulling' | 'pushing'`). Both are disabled while any op is in flight.

**Visual treatment:**
- Fetch & Pull: amber count badge when `behind > 0`; `glow-pulse` animation while pending; `WarnIcon` on sync error.
- Push: green count badge when `ahead > 0`; `glow-pulse` while pending.
- Both use the `SyncBtn` helper component which accepts `{ label, icon, count, countColor, active, error, disabled, onClick }`.

**Removed:** chevron dropdown, `doFetch` and `doPull` standalone functions, `menuOpen` state.

**Retained:** `UpdateFromMainBtn` and `doUpdateFromMain` are unchanged.

**New icon:** `FetchPullIcon` — a downward arrow with a dashed arc indicating a two-phase operation.

---

#### 24.4 Account Menu (Global Git Config + Sign Out)

The account avatar in TopBar now opens a dropdown (`AccountMenu` component) instead of being a purely decorative button.

**Trigger:** clicking the avatar + login name button toggles the dropdown. Closes on outside click via `mousedown` listener on `document`.

**Dropdown contents:**

*Global Git Config section* (top, separated by a border):
- Label: "Global Git Config" (uppercase, dim)
- Two text inputs: `user.name` and `user.email`, pre-populated from `ipc.getGlobalGitIdentity()` on open
- "Save" button: calls `ipc.setGlobalGitIdentity(name, email)` which runs `git config --global user.name <name>` and `git config --global user.email <email>` from the user's home directory. Button turns green and shows "✓ Saved" on success. Re-editing either field resets the button to "Save".
- Inputs are disabled (via styling) when empty; Save button has `opacity: 0.5` when either field is blank.

*Sign Out button* (bottom):
- Icon: door-with-arrow SVG
- Calls `useAuthStore.getState().logout(account.userId)` — the existing auth store action that removes the token from keychain and clears the account list.
- Hover state: red background tint.

**New IPC surface:**

```typescript
// electron/ipc/channels.ts
GIT_GET_GLOBAL_IDENTITY: 'git:get-global-identity',
GIT_SET_GLOBAL_IDENTITY: 'git:set-global-identity',

// electron/services/GitService.ts
async getGlobalGitIdentity(): Promise<{ name: string; email: string }>
async setGlobalGitIdentity(name: string, email: string): Promise<void>
// Both run from os.homedir() — git config --global reads/writes the user's ~/.gitconfig

// src/ipc.ts additions to LucidGitAPI
getGlobalGitIdentity: () => Promise<GitIdentity>
setGlobalGitIdentity: (name: string, email: string) => Promise<void>
```

---

#### 24.5 Session Restore

On app launch, `AppShell` checks whether a repo is already open and whether there are any recent repos. If both conditions hold (no open repo, at least one recent repo), it calls `openRepo(recentRepos[0])` automatically. This silently re-opens the last used repository without any user interaction.

```typescript
// AppShell.tsx — runs once on mount, after loadAccounts()
useEffect(() => {
  if (!repoPath && recentRepos.length > 0) {
    openRepo(recentRepos[0]).catch(() => {})
  }
}, [])
```

Errors are swallowed silently — if the last repo path no longer exists (deleted, unmounted drive, etc.) the app simply lands on the welcome screen as before. Recent repos are already stored in `localStorage` under `lucid-git:recent-repos` by `repoStore.addRecentRepo`.

---

### 25. Auth Hardening — Device Flow UX + EAUTH SSO + Account Persistence

Three improvements to the auth subsystem shipped together.

#### 25.1 DeviceFlowLogin — Progress Bar & Close Confirmation

Before this change, users with no visual feedback that polling was running would close the dialog manually, abandoning the auth flow silently. Two additions fix this:

**Indeterminate progress bar:**
A CSS `@keyframes lg-indeterminate` animated bar (sliding fill, width ~40% of container, speed 1.4s) rendered at the very top of the `DeviceFlowLogin` dialog wrapper — as a sibling to the padded content div, not inside it, so it doesn't affect layout. Active from the moment `deviceFlow` is truthy until the dialog closes.

**Close confirmation:**
Clicking × while `deviceFlow` is active sets `showCloseConfirm: true` instead of closing. This replaces the close button rendering with an amber inline warning block containing:
- Warning text: "Closing now will cancel authentication."
- "Cancel authentication" button — calls `clearDeviceFlow(); onClose()`
- "Keep waiting" button — sets `showCloseConfirm` back to false

When `deviceFlow` is null (no flow in progress), × closes immediately as before.

#### 25.2 EAUTH — GitHub Org SSO as a Known Cause

Added to the `EAUTH` error definition in `src/lib/gitErrors.ts`:
- **Cause:** `'Token not authorized for organization SSO'`
- **Fix:** `{ label: 'Authorize token for org SSO: github.com → Settings → Applications → find this app → Grant', command: 'start https://github.com/settings/connections/applications' }`

This is the most common field scenario where re-authenticating alone does not fix the error — the OAuth token needs to be explicitly authorized for the org's SSO policy.

#### 25.3 Account Persistence via `setCurrentAccount`

`authStore.setCurrentAccount(userId)` previously only updated the Zustand store in memory. On app restart the `currentAccountId` would be re-read from `auth.json` which hadn't been updated, causing the selected account to be lost.

Fix: the store action now also calls `ipc.setCurrentAccount(userId)` (fire-and-forget, errors swallowed). The IPC handler calls `AuthService.setCurrentAccount(userId)` which:
1. Reads `auth.json`
2. Verifies `userId` exists in the accounts array (guard against stale refs)
3. Updates `currentAccountId`
4. Writes `auth.json` back

New IPC channel: `AUTH_SET_CURRENT_ACCOUNT: 'auth:set-current-account'`.

---

### 26. Bug Logging System

A session log that persists the last 5 sessions to disk, surfaced through a "Bug Logs" page in the Tools sidebar group. The primary purpose is to capture error context that can be shared with Claude or read by developers to diagnose field failures without needing a debugger.

#### 26.1 `LogService` (main process singleton)

File: `electron/services/LogService.ts`

**Storage:** `{userData}/lucid-git-logs.json` — a JSON array of up to 5 `LogSession` objects. Older sessions roll off automatically.

**Session model:**
```typescript
interface LogEntry {
  ts: number          // unix ms
  level: 'INFO' | 'WARN' | 'ERROR'
  source: string      // e.g. 'git.push', 'AuthService', 'main'
  message: string
}

interface LogSession {
  sessionId: string   // nanoid
  startedAt: string   // ISO
  endedAt?: string
  entries: LogEntry[]
}
```

**API:**
```typescript
logService.init(userDataPath: string): void
// Loads past sessions, creates new current session with 'Application started' INFO entry.

logService.info(source: string, message: string): void
logService.warn(source: string, message: string): void
logService.error(source: string, message: string): void
// Appends a timestamped entry; schedules a 2s debounced async flush to disk.

logService.endSession(): void
// Marks endedAt, flushes synchronously. Called from app 'before-quit'.

logService.getFormattedText(): string
// Renders all sessions as plain text with ═══ divider headers per session,
// columns: HH:MM:SS.mmm LEVEL  source  message

logService.getSuggestion(): string | null
// Pattern-matches current session errors against known patterns:
// EAUTH, SSH failure, disk full, LFS quota, push rejected (non-fast-forward),
// merge conflict, pack corruption, admin permission, network timeout, large file (no LFS).
// Returns a plain-English fix hint, or null if nothing notable.

logService.saveToFile(filePath: string): void
// Synchronous write of getFormattedText() to a user-chosen path.
```

**Init:** `logService.init(app.getPath('userData'))` is called at the top of `app.whenReady()`, before IPC handler registration, so the service is ready for all subsequent calls.

**Hooks — where the app writes log entries:**
- `electron/util/dugite-exec.ts` — `exec()` and `execWithProgress()` log `ERROR` on non-zero exit code, including the git subcommand name and first 1000 chars of stderr
- `electron/services/AuthService.ts` — logs `INFO` on successful auth (`'Authenticated successfully as {login}'`), `WARN` on profile fetch failure, `INFO` on logout
- `electron/main.ts` — `app.whenReady()` start logged as `INFO`; `app.on('before-quit')` calls `logService.endSession()`

#### 26.2 IPC Surface

Three new channels (all request-reply):
- `LOG_GET_TEXT` → `logService.getFormattedText()` — returns the full plain-text log string
- `LOG_GET_SUGGESTION` → `logService.getSuggestion()` — returns a fix hint string or null
- `LOG_SAVE_DIALOG` → opens `dialog.showSaveDialog` with default filename `lucid-git-log-{YYYY-MM-DD}.txt`; if the user confirms, calls `logService.saveToFile(path)` and returns the saved path (or null if cancelled)

#### 26.3 `BugLogsPanel` (renderer)

File: `src/components/logs/BugLogsPanel.tsx`

Rendered when `leftTab === 'logs'` in `AppShell`.

**Layout (top to bottom):**
1. **Header bar** — log icon, "Bug Logs" title, "Last 5 sessions" label, Refresh button (spins while loading)
2. **Scrollable `<pre>` log area** — monospace font, auto-scrolled to bottom on load so the most recent entries are visible first
3. **Suggestion box** (conditional) — amber-tinted card with lightbulb icon, "Suggested Fix" label (all-caps), and the suggestion text. Only rendered when `getSuggestion()` returns a non-null value.
4. **Footer** — "Save log as .txt" button; saved path shown inline after a successful save

**Data loading:** `load()` fires `ipc.logGetText()` and `ipc.logGetSuggestion()` in parallel via `Promise.all`. Refresh button re-invokes `load()`.

#### 26.4 Sidebar Integration

- `'logs'` added to the `TabId` union in both `Sidebar.tsx` and `AppShell.tsx`
- `{ id: 'logs', label: 'Bug Logs', Icon: LogsIcon }` added to the **Tools** nav group in `Sidebar.tsx`
- Bug Logs is accessible **without a repo open** — the disabled-when-no-repo guard is lifted for `'logs'` (alongside `'settings'`)
- `LogsIcon` — a document-with-lines SVG matching the sidebar icon style

---

## What Claude Code cannot do (manual steps you handle)

1. **Create a GitHub OAuth App** — github.com/settings/developers → register new OAuth app, enable Device Flow, copy Client ID into Lucid Git config.
2. **Create the GitHub repo** for Lucid Git source + releases.
3. **(Optional) Code-signing certs** — Apple Developer ID ($99/yr), Windows EV cert (~$300/yr). Skip for internal team use; teammates can bypass SmartScreen/Gatekeeper once.
4. **App icon** — Claude can generate a 1024×1024 PNG but you may want to provide your own. Claude Code converts to .ico/.icns.

Everything else — code, config, tests, CI workflows — Claude Code generates.

---

## Known limitations — set your expectations

1. **Build time:** 40–80 hours of focused Claude Code sessions across 15 phases. This is a real application, not a weekend project.
2. **Electron has sharp edges** — native modules, ASAR, code signing, IPC serialization. Budget debugging time.
3. **Installer size ~120 MB** — dugite's bundled Git is ~40 MB per platform. Normal for Electron.
4. **First clone of a large UE repo is still slow** — Lucid Git can't make Git faster, only friendlier. Shallow + LFS mitigate this.
5. **GitHub LFS free tier is 1 GB storage / 1 GB bandwidth per month.** INFERIUS will need a paid LFS plan or self-hosted (e.g. Gitea). Lucid Git uses whatever backend you have.

---

*Lucid Git Specification v2.5 — Audited.*
*v2.5: Added Auth Hardening (Section 25) — DeviceFlowLogin indeterminate progress bar + close-confirmation guard, EAUTH org-SSO cause/fix, `setCurrentAccount` IPC for persistent account selection across restarts. Added Bug Logging System (Section 26) — `LogService` singleton keeping last 5 sessions in `lucid-git-logs.json`, `BugLogsPanel` under Tools (accessible without a repo), three new IPC channels (`log:get-text`, `log:get-suggestion`, `log:save-dialog`), logging hooks in `dugite-exec.ts` and `AuthService`. Updated Section 17 Dashboard — Fetch and Pull are now two separate buttons throughout (Daily Flow Strip, SyncCard, stale-pull warning); Pull is always disabled until `hasFetched` (set by a Fetch in the current session); `doPull()` no longer internally fetches. New IPC channel: `auth:set-current-account`.*
*v2.4: Added Asset Viewer Panel (Section 21), Global Tooltip System (Section 22), Panel Error Boundary (Section 23). Updated Section 1 with git subprocess authentication via `gitAuthArgs()` / `http.extraheader` injection — token from keytar now reaches all network git ops (push, pull, fetch, clone, deleteRemoteBranch, updateFromMain, setUpstream, cleanupShallow, cleanupUnshallow) and all LFS ops (listLocks, lockFile, unlockFile) via `AuthService.getCurrentToken()`. Updated Section 2 with owner-grouped collapsible locked-file sections in the Team tab. Updated Section 9 with undo-commit (soft reset to parent) via History panel right-click. Updated Section 20 to add Content Browser to the Tools navigation group. Added new stores: `assetViewerStore` (panel open/close state), `dialogStore` (custom dialog Promises). File Map null crash resolved by null-guarding all `Object.values(presResult.entries)` calls.*
*v2.3: Added Dashboard Panel (Section 17), Admin Role Preview (Section 18), Custom Dialog System (Section 19), and Navigation & Sidebar Redesign (Section 20). Dashboard is now the default landing panel for all users; Overview moved to the Admin sidebar group. Dashboard includes a personalized greeting, 3-step Daily Flow Strip (Sync/Work & Commit/Open PR), 3-column status grid, time-aware Suggestions card, and Activity feed showing recent commits. Admin Role Preview lets admins simulate Collaborator or Read-only access via a StatusBar dropdown, with a purple TopBar banner and "Switch back to Admin" affordance; `isAdmin()` respects `viewAsRole` override. Custom Dialog System replaces all native OS dialogs (`confirm`/`alert`/`prompt`) with themed in-app modals backed by a Promise-based Zustand store (`dialogStore`) and a global renderer (`GlobalDialogs`); Escape/Enter keyboard handling, danger mode, stacking prevention. Sidebar rebuilt with three collapsible groups (Workspace, Tools, Admin-only) persisted to localStorage, and a fixed bottom toolbar (Settings, View in Explorer, Open Terminal, Switch Repository).*
*v2.2: Added Role-Based Access Control (Section 16, Phase 20). Two-tier permission model (admin / write) sourced from GitHub API `GET /repos/{owner}/{repo}`. New `PermissionService` with GHE support and fail-open behavior. Admin-only gates on force-unlock, branch deletion, hard reset, LFS migration, cleanup, team config, webhooks, and UE config writes. Defense-in-depth: both UI (dim+disable with lock icon) and main process (IPC handler guard). New IPC channels `auth:fetch-repo-permission` and `auth:get-repo-permission`. Additions to `authStore`, `StatusBar` (permission badge), `TopBar` (warning on fetch failure), and admin-only panel banners.*
*v2.1: Added three game-dev differentiators — Binary Asset Diff Previews (Section 13, Phase 17), Dependency-Aware Blame (Section 14, Phase 18), Lock Heatmap + Conflict Forecasting (Section 15, Phase 19). New IPC channels for asset/dep/heatmap/forecast services. New SQLite tables `lock_events` and `conflict_events`. Added `sharp`, `d3-force`, `fluent-ffmpeg` (optional) to dependencies. New services: `AssetDiffService`, `UEHeadlessService`, `DependencyService`, `HeatmapService`, `ForecastService`. New components: `AssetDiffViewer`, `DependencyBlamePanel`, `ReferenceViewer`, `LockHeatmap`, `ForecastPanel`.*
*v2.0: Device Flow auth (PKCE doesn't work on desktop), dugite API correction (exec not git), removed Redis dep (bull → p-queue), removed redundant simple-git, current package versions verified April 2026, concrete IPC contract, git merge-tree for preview, serializable FixActions, electron-builder ASAR unpack for native modules, honest shallow-clone behavior, manual-steps callout.*

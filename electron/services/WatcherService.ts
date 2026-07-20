import { watch as fsWatch, type FSWatcher as NativeFSWatcher } from 'node:fs'
import chokidar, { FSWatcher } from 'chokidar'
import { logService } from './LogService'

type ChangeCallback = () => void

// Errors emitted by the underlying fs.watch on transient files (LFS tmp
// objects, pack tmp files, index.lock, etc.). These churn rapidly during git
// operations and surface as EPERM / ENOENT on Windows. Swallow them so they
// never escalate to unhandledRejection.
const TRANSIENT_WATCH_ERRORS = /^(EPERM|ENOENT|EBUSY|EACCES)\b/

// Files under .git/ that signal git-state changes we care about. Everything
// else in .git/ — LFS tmp objects, pack tmp files, index.lock churn — is noise.
const GIT_STATE_FILES = new Set([
  'HEAD', 'index', 'MERGE_HEAD', 'ORIG_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD',
])

// Build/editor-generated trees that never affect git status.
const IGNORED_SEGMENTS = /(?:^|\/)(?:node_modules|\.vs|Binaries|Intermediate|DerivedDataCache|Saved\/Autosaves)(?:\/|$)/

// Should a change at this repo-relative path trigger a status refresh?
function isRelevantChange(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/')
  const git = norm.match(/(?:^|\/)\.git(?:\/(.*))?$/)
  if (git) return git[1] !== undefined && GIT_STATE_FILES.has(git[1])
  return !IGNORED_SEGMENTS.test(norm)
}

class WatcherService {
  private disposers = new Map<string, () => void>()
  private timers    = new Map<string, ReturnType<typeof setTimeout>>()

  watch(repoPath: string, onChange: ChangeCallback): void {
    this.unwatch(repoPath)

    const fire = () => {
      const prev = this.timers.get(repoPath)
      if (prev) clearTimeout(prev)
      this.timers.set(repoPath, setTimeout(() => {
        this.timers.delete(repoPath)
        onChange()
      }, 500))
    }

    // Windows and macOS support OS-native recursive watching (one handle for
    // the whole tree, no crawl). This sees changes at any depth — UE content
    // typically lives 5+ directories deep, which a depth-limited per-directory
    // watcher misses entirely, leaving the changes list stale until a manual
    // refresh. Linux has no recursive fs.watch; fall back to chokidar there.
    if (process.platform === 'win32' || process.platform === 'darwin') {
      try {
        const watcher = this.watchNative(repoPath, fire)
        this.disposers.set(repoPath, () => watcher.close())
        return
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logService.warn('watcher', `native recursive watch failed in ${repoPath}, falling back to chokidar: ${msg}`)
      }
    }

    const watcher = this.watchChokidar(repoPath, fire)
    this.disposers.set(repoPath, () => { watcher.close().catch(() => {}) })
  }

  private watchNative(repoPath: string, fire: () => void): NativeFSWatcher {
    const watcher = fsWatch(repoPath, { recursive: true }, (_event, filename) => {
      // filename can be null when the OS buffer overflows — refresh to be safe.
      if (filename === null || isRelevantChange(String(filename))) fire()
    })
    watcher.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (TRANSIENT_WATCH_ERRORS.test(msg)) return
      logService.warn('watcher', `fs.watch error in ${repoPath}: ${msg}`)
    })
    return watcher
  }

  private watchChokidar(repoPath: string, fire: () => void): FSWatcher {
    const watcher = chokidar.watch(repoPath, {
      ignored: [
        // Never ignore the .git directory itself (chokidar must descend into
        // it), and within it keep only the git-state files. isRelevantChange
        // handles files; directories under .git/ must stay unignored so their
        // relevant children are reachable — but pruning them is safe because
        // every state file we care about sits directly in .git/.
        (filePath: string) => {
          const norm = filePath.replace(/\\/g, '/')
          const m = norm.match(/\.git\/(.*)$/)
          if (!m) return false
          return !GIT_STATE_FILES.has(m[1])
        },
        (filePath: string) => IGNORED_SEGMENTS.test(filePath.replace(/\\/g, '/')),
      ],
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    })

    watcher
      .on('add',       fire)
      .on('change',    fire)
      .on('unlink',    fire)
      .on('addDir',    fire)
      .on('unlinkDir', fire)
      .on('error', (err) => {
        const msg = err instanceof Error ? err.message : String(err)
        if (TRANSIENT_WATCH_ERRORS.test(msg)) return
        logService.warn('watcher', `chokidar error in ${repoPath}: ${msg}`)
      })
    return watcher
  }

  unwatch(repoPath: string): void {
    const timer = this.timers.get(repoPath)
    if (timer) { clearTimeout(timer); this.timers.delete(repoPath) }
    const dispose = this.disposers.get(repoPath)
    if (dispose) { dispose(); this.disposers.delete(repoPath) }
  }

  unwatchAll(): void {
    for (const key of [...this.disposers.keys()]) this.unwatch(key)
  }
}

export const watcherService = new WatcherService()

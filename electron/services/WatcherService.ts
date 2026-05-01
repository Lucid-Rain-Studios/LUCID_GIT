import chokidar, { FSWatcher } from 'chokidar'

type ChangeCallback = () => void

class WatcherService {
  private watchers = new Map<string, FSWatcher>()
  private timers   = new Map<string, ReturnType<typeof setTimeout>>()

  watch(repoPath: string, onChange: ChangeCallback): void {
    this.unwatch(repoPath)

    const watcher = chokidar.watch(repoPath, {
      ignored: [
        /[/\\]\.git[/\\]objects[/\\]/,
        /[/\\]\.git[/\\]lfs[/\\]objects[/\\]/,
        /[/\\]\.git[/\\]logs[/\\]/,
        /[/\\]\.git[/\\]refs[/\\]/,
        /[/\\]node_modules[/\\]/,
        /[/\\]\.vs[/\\]/,
        /[/\\]Binaries[/\\]/,
        /[/\\]Intermediate[/\\]/,
        /[/\\]DerivedDataCache[/\\]/,
        /[/\\]Saved[/\\]Autosaves[/\\]/,
      ],
      ignoreInitial: true,
      persistent: true,
      // Prevent expensive deep crawls on very large repos during first boot.
      // We only need near-root activity to trigger a lightweight refresh.
      depth: 3,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    })

    const fire = () => {
      const prev = this.timers.get(repoPath)
      if (prev) clearTimeout(prev)
      this.timers.set(repoPath, setTimeout(() => {
        this.timers.delete(repoPath)
        onChange()
      }, 500))
    }

    watcher
      .on('add',       fire)
      .on('change',    fire)
      .on('unlink',    fire)
      .on('addDir',    fire)
      .on('unlinkDir', fire)

    this.watchers.set(repoPath, watcher)
  }

  unwatch(repoPath: string): void {
    const timer = this.timers.get(repoPath)
    if (timer) { clearTimeout(timer); this.timers.delete(repoPath) }
    const watcher = this.watchers.get(repoPath)
    if (watcher) { watcher.close().catch(() => {}); this.watchers.delete(repoPath) }
  }

  unwatchAll(): void {
    for (const key of [...this.watchers.keys()]) this.unwatch(key)
  }
}

export const watcherService = new WatcherService()

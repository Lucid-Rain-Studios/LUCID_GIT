import { watch as fsWatch } from 'node:fs'
import path from 'node:path'
import chokidar from 'chokidar'
import { exec } from '../util/dugite-exec'
import { logService } from './LogService'

const TRANSIENT_WATCH_ERRORS = /^(EPERM|ENOENT|EBUSY|EACCES)\b/
const IGNORED_SEGMENTS = /(?:^|\/)(?:node_modules|\.vs|Binaries|Intermediate|DerivedDataCache|Saved\/Autosaves)(?:\/|$)/
const metadataRelevant = (file: string) => /^(HEAD|index|MERGE_HEAD|ORIG_HEAD|CHERRY_PICK_HEAD|REBASE_HEAD|packed-refs|config)$/.test(file) || file.startsWith('refs/')

class WatcherService {
  private disposers = new Map<string, () => void>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private sessions = new Map<string, object>()

  async watch(repoPath: string, onChange: () => void): Promise<void> {
    this.unwatch(repoPath)
    const session = {}
    this.sessions.set(repoPath, session)
    const current = () => this.sessions.get(repoPath) === session
    let tracked = new Set<string>(), loadingTracked = false
    const refreshTracked = async () => {
      if (loadingTracked) return
      loadingTracked = true
      try {
        const { stdout } = await exec(['ls-files', '-z'], repoPath)
        if (current()) tracked = new Set(stdout.split('\0').filter(Boolean))
      } finally { loadingTracked = false }
    }
    const [gitDirResult, commonResult] = await Promise.all([
      exec(['rev-parse', '--absolute-git-dir'], repoPath), exec(['rev-parse', '--git-common-dir'], repoPath), refreshTracked(),
    ])
    if (!current()) return
    const gitDir = path.resolve(repoPath, gitDirResult.stdout.trim())
    const commonDir = path.resolve(repoPath, commonResult.stdout.trim())
    const trackedDirectories = new Set<string>()
    const refreshDirectories = () => {
      trackedDirectories.clear()
      for (const file of tracked) { const parts = file.split('/'); for (let i = 1; i < parts.length; i++) trackedDirectories.add(parts.slice(0, i).join('/')) }
    }
    refreshDirectories()
    const relevant = (relative: string) => {
      const file = relative.replace(/\\/g, '/')
      if (file === '.git') return true
      if (file.startsWith('.git/')) return metadataRelevant(file.slice(5))
      return !IGNORED_SEGMENTS.test(file) || tracked.has(file)
    }
    const fire = (refreshIndex = false) => {
      if (!current()) return
      if (refreshIndex) void refreshTracked().then(refreshDirectories).catch(error => logService.warn('watcher.tracked', String(error)))
      const previous = this.timers.get(repoPath)
      if (previous) clearTimeout(previous)
      this.timers.set(repoPath, setTimeout(() => { this.timers.delete(repoPath); if (current()) onChange() }, 500))
    }
    const disposers: Array<() => void> = []
    const onError = (error: Error) => { if (!TRANSIENT_WATCH_ERRORS.test(error.message)) logService.warn('watcher', error.message) }
    const addWatcher = (root: string, metadata: boolean) => {
      const accepts = (file: string) => metadata ? metadataRelevant(file.replace(/\\/g, '/')) : relevant(file)
      if (process.platform === 'win32' || process.platform === 'darwin') {
        try {
          const watcher = fsWatch(root, { recursive: true }, (_event, filename) => {
            if (filename === null || accepts(String(filename))) fire(filename === null || /(?:^|[\\/])index$/.test(String(filename)))
          })
          watcher.on('error', onError)
          disposers.push(() => watcher.close())
          return
        } catch (error) { logService.warn('watcher', 'Native watch unavailable: ' + String(error)) }
      }
      const watcher = chokidar.watch(root, {
        ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
        ignored: (absolute: string) => {
          const file = path.relative(root, absolute).replace(/\\/g, '/')
          if (!file) return false
          if (metadata) return !metadataRelevant(file) && file !== 'refs'
          if (file === '.git') return false
          if (file.startsWith('.git/')) return !metadataRelevant(file.slice(5)) && file !== '.git/refs'
          return IGNORED_SEGMENTS.test(file) && !tracked.has(file) && !trackedDirectories.has(file)
        },
      })
      watcher.on('all', (_event, absolute) => { const file = path.relative(root, absolute); if (accepts(file)) fire(/(?:^|[\\/])index$/.test(file)) }).on('error', onError)
      disposers.push(() => { void watcher.close() })
    }
    addWatcher(repoPath, false)
    for (const dir of new Set([gitDir, commonDir])) if (dir !== path.join(repoPath, '.git')) addWatcher(dir, true)
    this.disposers.set(repoPath, () => disposers.forEach(dispose => dispose()))
  }

  unwatch(repoPath: string): void {
    this.sessions.delete(repoPath)
    const timer = this.timers.get(repoPath)
    if (timer) clearTimeout(timer)
    this.timers.delete(repoPath)
    this.disposers.get(repoPath)?.()
    this.disposers.delete(repoPath)
  }
  unwatchAll(): void { for (const repo of this.sessions.keys()) this.unwatch(repo) }
}
export const watcherService = new WatcherService()

import { useEffect, useRef } from 'react'
import { ipc } from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { useOperationStore } from '@/stores/operationStore'
import { getLastFetch, markFetchPerformed } from './fetchState'

// Owned by AppShell, so changing dashboard tabs never stops synchronization.
export function useAutoFetch(repoPath: string | null): void {
  const attempts = useRef(new Map<string, number>())
  const running = useRef(false)
  useEffect(() => {
    if (!repoPath) return
    let cancelled = false, minutes = 0
    const load = () => ipc.settingsGet().then(settings => { if (!cancelled) minutes = settings.autoFetchIntervalMinutes }).catch(() => {})
    void load()
    window.addEventListener('lucid-git:settings-changed', load)
    const timer = setInterval(async () => {
      if (minutes <= 0 || running.current || useOperationStore.getState().isRunning) return
      const base = Math.max(getLastFetch(repoPath) ?? 0, attempts.current.get(repoPath) ?? 0)
      if (Date.now() - base < minutes * 60_000) return
      attempts.current.set(repoPath, Date.now())
      running.current = true
      try {
        await ipc.fetch(repoPath, true)
        markFetchPerformed(repoPath)
        if (!cancelled && useRepoStore.getState().repoPath === repoPath) useRepoStore.getState().bumpSyncTick()
      } catch { /* Retry at the configured interval, never every tick. */ }
      finally { running.current = false }
    }, 1000)
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('lucid-git:settings-changed', load) }
  }, [repoPath])
}

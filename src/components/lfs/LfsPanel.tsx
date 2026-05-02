import React, { useEffect, useState } from 'react'
import { ipc, LFSStatus } from '@/ipc'
import { useOperationStore } from '@/stores/operationStore'
import { useDialogStore } from '@/stores/dialogStore'
import { cn } from '@/lib/utils'

interface LfsPanelProps {
  repoPath: string
}

function formatBytes(b: number): string {
  if (b === 0)          return '0 B'
  if (b < 1024)         return `${b} B`
  if (b < 1_048_576)    return `${(b / 1024).toFixed(1)} KB`
  if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(2)} MB`
  return `${(b / 1_073_741_824).toFixed(2)} GB`
}

export function LfsPanel({ repoPath }: LfsPanelProps) {
  const [status, setStatus]         = useState<LFSStatus | null>(null)
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState<string | null>(null)

  const [newPattern, setNewPattern] = useState('')
  const [tracking, setTracking]     = useState(false)

  const [selected, setSelected]     = useState<Set<string>>(new Set())
  const [migrating, setMigrating]   = useState(false)
  const [migrateErr, setMigrateErr] = useState<string | null>(null)
  const [migrateOk, setMigrateOk]  = useState(false)
  const opRun  = useOperationStore(s => s.run)
  const dialog = useDialogStore()

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await opRun('Scanning LFS…', () => ipc.lfsStatus(repoPath))
      setStatus(result)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [repoPath])

  const doTrack = async (patterns: string[]) => {
    setTracking(true)
    setError(null)
    try {
      await opRun(`Tracking ${patterns.join(', ')}…`, () => ipc.lfsTrack(repoPath, patterns))
      await load()
      setNewPattern('')
    } catch (e) {
      setError(String(e))
    } finally {
      setTracking(false)
    }
  }

  const doUntrack = async (pattern: string) => {
    const ok = await dialog.confirm({ title: 'Remove LFS tracking', message: `Remove tracking for "${pattern}"?`, detail: 'Existing LFS objects are not affected.', confirmLabel: 'Remove', danger: true })
    if (!ok) return
    setError(null)
    try {
      await ipc.lfsUntrack(repoPath, pattern)
      await load()
    } catch (e) {
      setError(String(e))
    }
  }

  const toggleSelect = (p: string) =>
    setSelected(prev => {
      const next = new Set(prev)
      next.has(p) ? next.delete(p) : next.add(p)
      return next
    })

  const doMigrate = async () => {
    if (selected.size === 0) return
    const ok = await dialog.confirm({
      title: `Migrate ${selected.size} pattern${selected.size !== 1 ? 's' : ''} to LFS`,
      message: 'This will rewrite Git history for ALL branches.',
      detail: 'You will need to force-push all branches afterward. Only proceed if you know what you are doing.',
      confirmLabel: 'Migrate History',
      danger: true,
    })
    if (!ok) return

    setMigrating(true)
    setMigrateErr(null)
    setMigrateOk(false)
    try {
      await opRun('Migrating history to LFS…', () => ipc.lfsMigrate(repoPath, [...selected]))
      setSelected(new Set())
      setMigrateOk(true)
      await load()
    } catch (e) {
      setMigrateErr(String(e))
    } finally {
      setMigrating(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">

      {/* ── LFS health summary ────────────────────────────────────── */}
      <div className="px-3 py-3 border-b border-lg-border shrink-0 space-y-3">
        {loading && (
          <span className="text-[10px] font-mono text-lg-text-secondary animate-pulse">Scanning…</span>
        )}
        {!loading && status && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <Stat label="Tracked patterns" value={status.tracked.length} />
            <Stat label="LFS objects"      value={status.objects} />
            <Stat label="Storage"          value={formatBytes(status.totalBytes)} />
            <Stat
              label="Coverage"
              value={status.untracked.length > 0 ? `⚠ ${status.untracked.length} uncovered` : 'OK'}
              warn={status.untracked.length > 0}
            />
          </div>
        )}
        {!loading && status && (
          <div className="space-y-2">
            <div className="text-[10px] font-mono uppercase tracking-widest text-lg-text-secondary">
              Tracked patterns preview
            </div>
            <div className="flex flex-wrap gap-1.5">
              {status.tracked.length === 0 && (
                <span className="text-[10px] font-mono text-lg-text-secondary">No patterns tracked yet.</span>
              )}
              {status.tracked.slice(0, 10).map((p, i) => (
                <span key={`${p}-${i}`} className="px-1.5 py-0.5 rounded border border-lg-border bg-lg-bg-elevated text-[10px] font-mono text-lg-text-primary">
                  {p}
                </span>
              ))}
              {status.tracked.length > 10 && (
                <span className="text-[10px] font-mono text-lg-text-secondary">+{status.tracked.length - 10} more</span>
              )}
            </div>
          </div>
        )}
        {error && (
          <div className="text-[10px] font-mono text-lg-error mt-1">{error}</div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">

        {/* ── Tracked patterns ──────────────────────────────────────── */}
        <Section label={`Tracked patterns (${status?.tracked.length ?? 0})`}>
          {status?.tracked.length === 0 && (
            <div className="px-3 py-2 text-[10px] font-mono text-lg-text-secondary">
              No patterns tracked yet.
            </div>
          )}
          {status?.tracked.map(p => (
            <div key={p} className="flex items-center gap-2 px-3 py-1.5 group hover:bg-lg-bg-elevated transition-colors">
              <span className="flex-1 text-[11px] font-mono text-lg-text-primary">{p}</span>
              <button
                onClick={() => doUntrack(p)}
                title="Remove LFS tracking for this pattern"
                className="opacity-0 group-hover:opacity-100 text-[9px] font-mono text-lg-error hover:text-lg-error/80 transition-all"
              >
                untrack
              </button>
            </div>
          ))}

          {/* Add pattern */}
          <div className="flex gap-1 px-3 py-2 border-t border-lg-border/50">
            <input
              value={newPattern}
              onChange={e => setNewPattern(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && newPattern.trim() && doTrack([newPattern.trim()])}
              placeholder="e.g. *.psd  or  Assets/**/*.uasset"
              className="flex-1 min-w-0 bg-lg-bg-primary border border-lg-border rounded px-2 py-1 text-[11px] font-mono text-lg-text-primary placeholder:text-lg-text-secondary focus:outline-none focus:border-lg-accent transition-colors"
            />
            <button
              onClick={() => newPattern.trim() && doTrack([newPattern.trim()])}
              disabled={!newPattern.trim() || tracking}
              className="shrink-0 px-2 h-7 rounded text-[10px] font-mono border border-lg-border text-lg-text-secondary hover:border-lg-accent hover:text-lg-accent disabled:opacity-40 transition-colors"
            >
              {tracking ? '…' : '+ Track'}
            </button>
          </div>
        </Section>

        {/* ── Suggested patterns ────────────────────────────────────── */}
        {status && status.untracked.length > 0 && (
          <Section label={`Suggested — binary files not in LFS (${status.untracked.length})`}>
            <div className="px-3 py-1.5 text-[10px] font-mono text-lg-text-secondary">
              These file types exist in the repo but aren't tracked by LFS. Select patterns to track or migrate.
            </div>
            {status.untracked.map(p => (
              <div key={p} className="flex items-center gap-2 px-3 py-1.5 hover:bg-lg-bg-elevated transition-colors">
                <input
                  type="checkbox"
                  checked={selected.has(p)}
                  onChange={() => toggleSelect(p)}
                  className="accent-lg-accent"
                />
                <span className="flex-1 text-[11px] font-mono text-lg-warning">{p}</span>
                <button
                  onClick={() => doTrack([p])}
                  disabled={tracking}
                  className="shrink-0 px-1.5 h-5 rounded text-[9px] font-mono border border-lg-border text-lg-text-secondary hover:border-lg-accent hover:text-lg-accent disabled:opacity-40 transition-colors"
                >
                  Track
                </button>
              </div>
            ))}

            {/* Migrate section */}
            {selected.size > 0 && (
              <div className="px-3 py-2 border-t border-lg-border/50 space-y-1.5">
                <div className="text-[10px] font-mono text-lg-warning">
                  ⚠ Migrate rewrites Git history. Force-push required after.
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => doTrack([...selected])}
                    disabled={tracking || migrating}
                    className="px-2 h-6 rounded text-[10px] font-mono border border-lg-border text-lg-text-secondary hover:border-lg-accent hover:text-lg-accent disabled:opacity-40 transition-colors"
                  >
                    Track only ({selected.size})
                  </button>
                  <button
                    onClick={doMigrate}
                    disabled={migrating || tracking}
                    className="px-2 h-6 rounded text-[10px] font-mono border border-lg-warning/50 text-lg-warning hover:bg-lg-warning/10 disabled:opacity-40 transition-colors"
                  >
                    {migrating ? 'Migrating…' : `Migrate history (${selected.size})`}
                  </button>
                </div>
                {migrateErr && (
                  <div className="text-[10px] font-mono text-lg-error whitespace-pre-wrap">{migrateErr}</div>
                )}
                {migrateOk && (
                  <div className="text-[10px] font-mono text-lg-success">
                    ✓ Migration complete. Force-push all branches to sync remotes.
                  </div>
                )}
              </div>
            )}
          </Section>
        )}

        {status && status.untracked.length === 0 && status.tracked.length > 0 && (
          <div className="px-3 py-3 text-[10px] font-mono text-lg-success">
            ✓ All binary files in the repo are covered by LFS tracking rules.
          </div>
        )}
      </div>

      {/* ── Footer: refresh ────────────────────────────────────────── */}
      <div className="px-3 py-2 border-t border-lg-border shrink-0">
        <button
          onClick={load}
          disabled={loading}
          className="w-full h-7 rounded text-[10px] font-mono border border-lg-border text-lg-text-secondary hover:border-lg-accent hover:text-lg-accent disabled:opacity-40 transition-colors"
        >
          {loading ? 'Scanning…' : '↺ Refresh'}
        </button>
      </div>
    </div>
  )
}

function Stat({ label, value, warn = false }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className={cn('flex flex-col rounded border px-2 py-1.5 bg-lg-bg-secondary/50', warn ? 'border-lg-warning/40' : 'border-lg-border')}>
      <span className="text-[9px] font-mono uppercase tracking-widest text-lg-text-secondary">{label}</span>
      <span className={cn('text-xs font-mono font-semibold', warn ? 'text-lg-warning' : 'text-lg-text-primary')}>{value}</span>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-lg-border">
      <div className="px-3 py-1.5 bg-lg-bg-secondary sticky top-0 z-10">
        <span className="text-[10px] font-mono uppercase tracking-widest text-lg-text-secondary">{label}</span>
      </div>
      {children}
    </div>
  )
}

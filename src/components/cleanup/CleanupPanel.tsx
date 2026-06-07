import React, { useEffect, useState } from 'react'
import { ipc, SizeBreakdown, CleanupResult } from '@/ipc'
import { useOperationStore } from '@/stores/operationStore'
import { cn } from '@/lib/utils'
import { ActionBtn as SharedActionBtn } from '@/components/ui/ActionBtn'

interface CleanupPanelProps {
  repoPath: string
}

function fmt(b: number): string {
  if (b <= 0)              return '0 B'
  if (b < 1_024)           return `${b} B`
  if (b < 1_048_576)       return `${(b / 1_024).toFixed(1)} KB`
  if (b < 1_073_741_824)   return `${(b / 1_048_576).toFixed(1)} MB`
  return `${(b / 1_073_741_824).toFixed(2)} GB`
}

function Bar({ value, total, color }: { value: number; total: number; color: string }) {
  const pct = total > 0 ? Math.max(2, Math.round((value / total) * 100)) : 0
  return (
    <div className="h-1.5 w-full bg-lg-border/40 rounded-full overflow-hidden">
      <div className={cn('h-full rounded-full transition-all duration-500', color)} style={{ width: `${pct}%` }} />
    </div>
  )
}

function SizeRow({
  label, bytes, total, color,
}: { label: string; bytes: number; total: number; color: string }) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-[10px] font-mono">
        <span className="text-lg-text-secondary">{label}</span>
        <span className="text-lg-text-primary">{fmt(bytes)}</span>
      </div>
      <Bar value={bytes} total={total} color={color} />
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-lg-border">
      <div className="px-3 py-1.5 bg-lg-bg-secondary sticky top-0 z-10">
        <span className="text-[10px] font-mono uppercase tracking-widest text-lg-text-secondary">{title}</span>
      </div>
      <div className="px-3 py-2.5 space-y-2">
        {children}
      </div>
    </div>
  )
}

function ResultBadge({ result }: { result: CleanupResult }) {
  const saved = result.savedBytes
  return (
    <div className={cn(
      'text-[10px] font-mono px-2 py-1 rounded',
      saved > 0 ? 'text-lg-success bg-lg-success/10' : 'text-lg-text-secondary bg-lg-border/20'
    )}>
      {saved > 0
        ? `✓ Freed ${fmt(saved)}  (${fmt(result.beforeBytes)} → ${fmt(result.afterBytes)})`
        : `✓ Nothing to reclaim  (${fmt(result.afterBytes)})`}
    </div>
  )
}

export function CleanupPanel({ repoPath }: CleanupPanelProps) {
  const opRun = useOperationStore(s => s.run)

  const [size, setSize]           = useState<SizeBreakdown | null>(null)
  const [sizeLoading, setSizeLoading] = useState(false)
  const [sizeError, setSizeError] = useState<string | null>(null)

  const [gcResult, setGcResult]   = useState<CleanupResult | null>(null)
  const [gcRunning, setGcRunning] = useState(false)
  const [gcError, setGcError]     = useState<string | null>(null)

  const [pruneRunning, setPruneRunning] = useState(false)
  const [pruneOk, setPruneOk]           = useState(false)
  const [pruneError, setPruneError]     = useState<string | null>(null)

  const [depth, setDepth]               = useState('50')
  const [shallowRunning, setShallowRunning] = useState(false)
  const [shallowOk, setShallowOk]           = useState(false)
  const [shallowError, setShallowError]     = useState<string | null>(null)

  const loadSize = async () => {
    setSizeLoading(true)
    setSizeError(null)
    try {
      const result = await opRun('Measuring repository size…', () => ipc.cleanupSize(repoPath))
      setSize(result)
    } catch (e) {
      setSizeError(String(e))
    } finally {
      setSizeLoading(false)
    }
  }

  useEffect(() => { loadSize() }, [repoPath])

  const doGc = async (aggressive: boolean) => {
    setGcRunning(true)
    setGcResult(null)
    setGcError(null)
    try {
      const label = aggressive ? 'Running git gc --aggressive…' : 'Running git gc…'
      const result = await opRun(label, () => ipc.cleanupGc(repoPath, aggressive))
      setGcResult(result)
      setSize(s => s ? { ...s, totalBytes: result.afterBytes } : s)
    } catch (e) {
      setGcError(String(e))
    } finally {
      setGcRunning(false)
    }
  }

  const doPruneLfs = async () => {
    setPruneRunning(true)
    setPruneOk(false)
    setPruneError(null)
    try {
      await opRun('Pruning LFS objects…', () => ipc.cleanupPruneLfs(repoPath))
      setPruneOk(true)
      await loadSize()
    } catch (e) {
      setPruneError(String(e))
    } finally {
      setPruneRunning(false)
    }
  }

  const doShallow = async () => {
    const d = parseInt(depth)
    if (!d || d < 1) return
    setShallowRunning(true)
    setShallowOk(false)
    setShallowError(null)
    try {
      await opRun(`Shallowing to depth ${d}…`, () => ipc.cleanupShallow(repoPath, d))
      setShallowOk(true)
      await loadSize()
    } catch (e) {
      setShallowError(String(e))
    } finally {
      setShallowRunning(false)
    }
  }

  const doUnshallow = async () => {
    setShallowRunning(true)
    setShallowOk(false)
    setShallowError(null)
    try {
      await opRun('Fetching full history…', () => ipc.cleanupUnshallow(repoPath))
      setShallowOk(true)
      await loadSize()
    } catch (e) {
      setShallowError(String(e))
    } finally {
      setShallowRunning(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">

        {/* ── Repository size ───────────────────────────────────────── */}
        <Section title="Repository size">
          {sizeLoading && (
            <p className="text-[10px] font-mono text-lg-text-secondary animate-pulse">Measuring…</p>
          )}
          {sizeError && (
            <p className="text-[10px] font-mono text-lg-error">{sizeError}</p>
          )}
          {size && !sizeLoading && (
            <div className="space-y-3">
              <div className="flex items-baseline gap-2">
                <span className="text-lg font-mono font-bold text-lg-text-primary">{fmt(size.totalBytes)}</span>
                <span className="text-[10px] font-mono text-lg-text-secondary">total .git directory</span>
              </div>
              <div className="space-y-2">
                <SizeRow label="Pack files"  bytes={size.packsBytes}    total={size.totalBytes} color="bg-[#4a9eff]" />
                <SizeRow label="Loose objects" bytes={Math.max(0, size.objectsBytes - size.packsBytes)} total={size.totalBytes} color="bg-lg-accent" />
                <SizeRow label={size.approximate ? "LFS cache (approx)" : "LFS cache"}   bytes={size.lfsCacheBytes} total={size.totalBytes} color="bg-lg-success" />
                <SizeRow label="Logs"        bytes={size.logsBytes}     total={size.totalBytes} color="bg-lg-text-secondary" />
              </div>
            </div>
          )}
          <SharedActionBtn
            onClick={loadSize}
            disabled={sizeLoading}
            size="sm"
            style={{ marginTop: 4, height: 24, paddingLeft: 8, paddingRight: 8, fontSize: 10, fontFamily: 'var(--lg-font-mono)' }}
          >
            {sizeLoading ? 'Measuring…' : '↺ Refresh'}
          </SharedActionBtn>
        </Section>

        {/* ── Git GC ───────────────────────────────────────────────── */}
        <Section title="Git garbage collection">
          <p className="text-[10px] font-mono text-lg-text-secondary leading-relaxed">
            Compresses pack files, removes unreachable objects, and optimises the local object store.
          </p>
          <div className="flex gap-2">
            <ActionBtn
              label="Run GC"
              busy={gcRunning}
              onClick={() => doGc(false)}
              title="git gc --quiet"
            />
            <ActionBtn
              label="Run GC (aggressive)"
              busy={gcRunning}
              onClick={() => doGc(true)}
              title="git gc --aggressive — slower but more thorough"
              warn
            />
          </div>
          {gcError  && <p className="text-[10px] font-mono text-lg-error">{gcError}</p>}
          {gcResult && <ResultBadge result={gcResult} />}
        </Section>

        {/* ── LFS prune ────────────────────────────────────────────── */}
        <Section title="LFS prune">
          <p className="text-[10px] font-mono text-lg-text-secondary leading-relaxed">
            Deletes locally cached LFS objects that are not referenced by any local branch or tag.
          </p>
          <ActionBtn
            label="Prune LFS cache"
            busy={pruneRunning}
            onClick={doPruneLfs}
            title="git lfs prune"
          />
          {pruneError && <p className="text-[10px] font-mono text-lg-error">{pruneError}</p>}
          {pruneOk && !pruneError && (
            <p className="text-[10px] font-mono text-lg-success">✓ LFS prune complete</p>
          )}
        </Section>

        {/* ── Shallow clone ─────────────────────────────────────────── */}
        <Section title="Shallow clone">
          <p className="text-[10px] font-mono text-lg-text-secondary leading-relaxed">
            Limit history to the most recent commits to reduce clone size, or restore full history.
          </p>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-lg-text-secondary shrink-0">Depth</span>
            <input
              type="number"
              min={1}
              value={depth}
              onChange={e => setDepth(e.target.value)}
              className="w-16 bg-lg-bg-primary border border-lg-border rounded px-2 py-1 text-[11px] font-mono text-lg-text-primary focus:outline-none focus:border-lg-accent transition-colors"
            />
            <ActionBtn
              label="Make shallow"
              busy={shallowRunning}
              onClick={doShallow}
              title={`git fetch --depth ${depth}`}
              warn
            />
          </div>
          <ActionBtn
            label="Fetch full history"
            busy={shallowRunning}
            onClick={doUnshallow}
            title="git fetch --unshallow"
          />
          {shallowError && <p className="text-[10px] font-mono text-lg-error">{shallowError}</p>}
          {shallowOk && !shallowError && (
            <p className="text-[10px] font-mono text-lg-success">✓ Done</p>
          )}
        </Section>

      </div>
    </div>
  )
}

function ActionBtn({
  label, busy, onClick, title, warn,
}: {
  label: string
  busy: boolean
  onClick: () => void
  title?: string
  warn?: boolean
}) {
  return (
    <SharedActionBtn
      onClick={onClick}
      disabled={busy}
      title={title}
      color={warn ? '#f5a832' : undefined}
      size="sm"
      style={{ height: 28, paddingLeft: 10, paddingRight: 10, fontSize: 10, fontFamily: 'var(--lg-font-mono)' }}
    >
      {busy ? '…' : label}
    </SharedActionBtn>
  )
}

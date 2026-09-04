import React, { useCallback, useEffect, useRef, useState } from 'react'
import { BranchHealth, BranchHealthReport, ipc } from '@/ipc'
import { cn } from '@/lib/utils'
import { FilePathText } from '@/components/ui/FilePathText'
import { ActionBtn } from '@/components/ui/ActionBtn'

/**
 * Answers "which branches can I merge right now?" before anyone starts a merge.
 *
 * Each unmerged branch is merged against the default branch in memory, so a
 * conflicting `.umap` shows up here rather than halfway through a checkout that
 * then has to be unwound. Runs on demand: it is one git process per unmerged
 * branch, which is cheap but not free, and the answer only changes when someone
 * pushes.
 */

// Conflicts first, then whatever has drifted furthest — that ordering puts the
// branches most expensive to merge later at the top.
const RISK: Record<BranchHealth['status'], number> = {
  conflicted: 0, error: 1, skipped: 2, clean: 3, merged: 4,
}

function byRisk(a: BranchHealth, b: BranchHealth): number {
  return RISK[a.status] - RISK[b.status] || b.behind - a.behind
}

function StatusDot({ status }: { status: BranchHealth['status'] }) {
  const color =
    status === 'conflicted' ? 'bg-lg-error'
    : status === 'clean' ? 'bg-lg-success'
    : status === 'error' ? 'bg-lg-error/40'
    : 'bg-lg-text-secondary/40'
  return <span className={cn('shrink-0 w-1.5 h-1.5 rounded-full', color)} />
}

function DriftPill({ n, dir }: { n: number; dir: 'ahead' | 'behind' }) {
  if (n === 0) return null
  return (
    <span className={cn(
      'shrink-0 px-1 rounded text-[9px] font-mono leading-4',
      dir === 'ahead' ? 'text-lg-success bg-lg-success/10' : 'text-lg-warning bg-lg-warning/10',
    )}>
      {dir === 'ahead' ? '↑' : '↓'}{n}
    </span>
  )
}

function BranchRow({ branch, onPreview }: { branch: BranchHealth; onPreview?: (name: string) => void }) {
  const [showFiles, setShowFiles] = useState(false)
  const conflicted = branch.status === 'conflicted'

  return (
    <div className="px-3 py-1 border-b border-lg-border/40 last:border-b-0">
      <div className="flex items-center gap-2 min-w-0">
        <StatusDot status={branch.status} />
        <span
          className="font-mono text-[11px] text-lg-text-primary truncate cursor-default"
          title={branch.name}
        >
          {branch.name}
        </span>
        <DriftPill n={branch.ahead} dir="ahead" />
        <DriftPill n={branch.behind} dir="behind" />
        <span className="flex-1" />

        {conflicted && (
          <button
            onClick={() => setShowFiles(v => !v)}
            className="shrink-0 text-[10px] font-mono text-lg-error hover:underline"
          >
            {branch.conflicts.length} conflict{branch.conflicts.length !== 1 ? 's' : ''} {showFiles ? '▾' : '▸'}
          </button>
        )}
        {branch.status === 'clean' && (
          <span className="shrink-0 text-[10px] font-mono text-lg-success">merges clean</span>
        )}
        {branch.status === 'skipped' && (
          <span className="shrink-0 text-[10px] font-mono text-lg-text-secondary">not checked</span>
        )}
        {branch.status === 'error' && (
          <span className="shrink-0 text-[10px] font-mono text-lg-text-secondary" title="git could not compute this merge">
            could not check
          </span>
        )}

        {conflicted && onPreview && (
          <button
            onClick={() => onPreview(branch.name)}
            className="shrink-0 text-[10px] font-mono text-lg-text-secondary hover:text-lg-accent"
          >
            preview
          </button>
        )}
      </div>

      {conflicted && showFiles && (
        <div className="pl-4 pt-1 pb-0.5 flex flex-col gap-0.5">
          {branch.conflicts.map(p => (
            <FilePathText key={p} path={p} className="text-[10px] font-mono text-lg-text-secondary" />
          ))}
        </div>
      )}
    </div>
  )
}

export function BranchHealthCard({ repoPath, onPreview }: {
  repoPath: string
  onPreview?: (branchName: string) => void
}) {
  const [report, setReport] = useState<BranchHealthReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [showClean, setShowClean] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // A report describes one repository; carrying it across a switch would
  // attribute one project's conflicts to another.
  useEffect(() => { setReport(null); setError(null); setExpanded(false) }, [repoPath])

  const check = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await ipc.branchHealth(repoPath)
      if (!mounted.current) return
      setReport(next)
      setExpanded(true)
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [repoPath])

  // "merged" branches hold nothing to merge, so they are noise in a view about
  // what merging would do.
  const actionable = (report?.branches ?? []).filter(b => b.status !== 'merged').sort(byRisk)
  const conflicted = actionable.filter(b => b.status === 'conflicted')
  const visible = showClean ? actionable : actionable.filter(b => b.status !== 'clean')

  return (
    <div className="shrink-0 border-b border-lg-border bg-lg-bg-secondary">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-[10px] font-mono uppercase tracking-widest text-lg-text-secondary">
          Branch Health
        </span>
        {report && (
          <span className="text-[10px] font-mono text-lg-text-secondary/60">
            vs {report.base}
          </span>
        )}
        <span className="flex-1" />

        {report && (
          <span className={cn(
            'text-[10px] font-mono',
            conflicted.length > 0 ? 'text-lg-error' : 'text-lg-success',
          )}>
            {conflicted.length > 0
              ? `${conflicted.length} of ${report.checked} will conflict`
              : `all ${report.checked} merge clean`}
          </span>
        )}

        {report && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="text-[10px] font-mono text-lg-text-secondary hover:text-lg-accent"
          >
            {expanded ? 'hide' : 'show'}
          </button>
        )}

        <ActionBtn
          onClick={check}
          disabled={busy}
          size="sm"
          style={{ height: 22, flexShrink: 0, fontFamily: 'var(--lg-font-mono)', fontSize: 10 }}
        >
          {busy ? '…' : report ? 'Recheck' : 'Check'}
        </ActionBtn>
      </div>

      {error && (
        <div className="px-3 pb-1.5 text-[10px] font-mono text-lg-error whitespace-pre-wrap">{error}</div>
      )}

      {!report && !error && !busy && (
        <div className="px-3 pb-1.5 text-[10px] font-mono text-lg-text-secondary">
          Merges every unmerged branch in memory to find conflicts before you start one. Nothing is checked out.
        </div>
      )}

      {report && expanded && (
        <>
          {visible.length === 0 && (
            <div className="px-3 pb-1.5 text-[10px] font-mono text-lg-text-secondary">
              Nothing to merge — every branch is already contained in {report.base}.
            </div>
          )}

          <div className="max-h-64 overflow-y-auto">
            {visible.map(b => <BranchRow key={b.name} branch={b} onPreview={onPreview} />)}
          </div>

          <div className="flex items-center gap-3 px-3 py-1 border-t border-lg-border/40">
            <button
              onClick={() => setShowClean(v => !v)}
              className="text-[10px] font-mono text-lg-text-secondary hover:text-lg-accent"
            >
              {showClean ? 'hide clean branches' : `show ${actionable.filter(b => b.status === 'clean').length} clean`}
            </button>
            {report.skipped > 0 && (
              <span className="text-[10px] font-mono text-lg-warning">
                {report.skipped} not checked — too many branches to merge in one pass
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

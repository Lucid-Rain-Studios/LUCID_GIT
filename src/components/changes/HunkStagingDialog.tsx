import React, { useEffect, useMemo, useState } from 'react'
import { ipc } from '@/ipc'
import { ActionBtn } from '@/components/ui/ActionBtn'
import { AppCheckbox } from '@/components/ui/AppCheckbox'

interface Hunk {
  header: string         // the `@@ -a,b +c,d @@ heading` line, verbatim
  body:   string[]       // lines after the header, terminated by the next hunk or EOF
}

interface ParsedDiff {
  fileHeader: string[]   // every line before the first @@ (diff --git, ---, +++, etc.)
  hunks:      Hunk[]
}

/**
 * Split a raw unified diff into its file header and individual hunks.
 * Assumes a single-file diff, which is what `git diff -- <path>` produces.
 */
function parseDiff(raw: string): ParsedDiff {
  const lines = raw.split('\n')
  // Keep the trailing empty token if present so we can re-join cleanly.
  const fileHeader: string[] = []
  const hunks: Hunk[] = []
  let i = 0
  while (i < lines.length && !lines[i].startsWith('@@')) {
    fileHeader.push(lines[i])
    i++
  }
  while (i < lines.length) {
    if (!lines[i].startsWith('@@')) { i++; continue }
    const header = lines[i++]
    const body: string[] = []
    while (i < lines.length && !lines[i].startsWith('@@')) {
      body.push(lines[i++])
    }
    hunks.push({ header, body })
  }
  return { fileHeader, hunks }
}

/** Reassemble a patch from the original header + a subset of hunks. */
function buildPatch(parsed: ParsedDiff, selected: Set<number>): string {
  if (selected.size === 0) return ''
  const parts: string[] = [...parsed.fileHeader]
  parsed.hunks.forEach((h, idx) => {
    if (!selected.has(idx)) return
    parts.push(h.header)
    parts.push(...h.body)
  })
  // Patches must end with a newline so git can parse the final hunk.
  let out = parts.join('\n')
  if (!out.endsWith('\n')) out += '\n'
  return out
}

interface HunkStagingDialogProps {
  repoPath: string
  filePath: string
  /** When true, generate the diff from the index (--cached) and reverse-apply
   *  to unstage. When false, stage hunks from the working tree. */
  reverse?: boolean
  onClose:    () => void
  onComplete: () => void
}

export function HunkStagingDialog({ repoPath, filePath, reverse = false, onClose, onComplete }: HunkStagingDialogProps) {
  const [raw, setRaw]               = useState<string>('')
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)
  const [applying, setApplying]     = useState(false)
  const [selected, setSelected]     = useState<Set<number>>(new Set())

  const parsed = useMemo<ParsedDiff>(() => parseDiff(raw), [raw])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    ipc.diffRaw(repoPath, filePath, reverse).then(text => {
      if (cancelled) return
      setRaw(text)
      // Pre-select all hunks — most workflows want "stage everything except X".
      const all = new Set<number>()
      const { hunks } = parseDiff(text)
      hunks.forEach((_, i) => all.add(i))
      setSelected(all)
    }).catch(e => {
      if (!cancelled) setError(String(e))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [repoPath, filePath, reverse])

  const toggle = (idx: number) => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(idx)) next.delete(idx)
    else next.add(idx)
    return next
  })

  const selectAll = () => setSelected(new Set(parsed.hunks.map((_, i) => i)))
  const selectNone = () => setSelected(new Set())

  const handleApply = async () => {
    if (selected.size === 0) return
    setApplying(true); setError(null)
    try {
      const patch = buildPatch(parsed, selected)
      await ipc.applyPatch(repoPath, patch, reverse)
      onComplete()
    } catch (e) {
      setError(String(e))
    } finally {
      setApplying(false)
    }
  }

  const verb       = reverse ? 'Unstage' : 'Stage'
  const verbActive = reverse ? 'Unstaging' : 'Staging'

  return (
    <div
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{
        width: '90%', maxWidth: 900, height: '80%',
        background: 'var(--lg-bg-secondary)', border: '1px solid var(--lg-border)',
        borderRadius: 8, boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px', borderBottom: '1px solid var(--lg-border)',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--lg-text-primary)' }}>
              {verb} hunks
            </div>
            <div style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: 'var(--lg-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {filePath}
            </div>
          </div>
          <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: 'var(--lg-text-secondary)' }}>
            {selected.size}/{parsed.hunks.length} hunks
          </span>
          <ActionBtn onClick={selectAll}  size="sm" style={{ height: 24, fontSize: 11 }}>All</ActionBtn>
          <ActionBtn onClick={selectNone} size="sm" style={{ height: 24, fontSize: 11 }}>None</ActionBtn>
          <ActionBtn
            onClick={handleApply}
            disabled={applying || selected.size === 0}
            color={reverse ? '#f5a832' : '#2dbd6e'}
            size="sm"
            style={{ height: 24, fontSize: 11, fontWeight: 600 }}
          >
            {applying ? `${verbActive}…` : `${verb} ${selected.size}`}
          </ActionBtn>
          <ActionBtn onClick={onClose} size="sm" style={{ height: 24, fontSize: 11 }}>Close</ActionBtn>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', background: '#0d0f15' }}>
          {loading && (
            <div style={{ padding: 20, fontFamily: 'var(--lg-font-mono)', fontSize: 12, color: '#344057' }}>
              Loading diff…
            </div>
          )}
          {!loading && error && (
            <div style={{ padding: 14, fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#e84545', whiteSpace: 'pre-wrap' }}>
              {error}
            </div>
          )}
          {!loading && !error && parsed.hunks.length === 0 && (
            <div style={{ padding: 20, fontFamily: 'var(--lg-font-mono)', fontSize: 12, color: '#344057' }}>
              No diff for this file. The change may be binary, file-mode-only, or already staged.
            </div>
          )}
          {!loading && !error && parsed.hunks.map((h, idx) => (
            <HunkBlock
              key={idx}
              hunk={h}
              checked={selected.has(idx)}
              onToggle={() => toggle(idx)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function HunkBlock({ hunk, checked, onToggle }: { hunk: Hunk; checked: boolean; onToggle: () => void }) {
  return (
    <div style={{
      borderBottom: '1px solid #181d2e',
      background: checked ? 'transparent' : 'rgba(0,0,0,0.35)',
      opacity: checked ? 1 : 0.55,
      transition: 'opacity 0.1s, background 0.1s',
    }}>
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '6px 12px',
          background: '#10141f', borderBottom: '1px solid #1c2233',
          cursor: 'pointer', userSelect: 'none',
        }}
      >
        <AppCheckbox checked={checked} onChange={onToggle} color="#2ec573" />
        <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#8b94b0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {hunk.header}
        </span>
      </div>
      <pre style={{
        margin: 0, padding: '4px 0',
        fontFamily: '"JetBrains Mono", Consolas, "Courier New", monospace',
        fontSize: 11, lineHeight: 1.45,
      }}>
        {hunk.body.map((line, i) => {
          const c = line.startsWith('+') ? '#2ec573'
            : line.startsWith('-') ? '#e84545'
            : '#8b94b0'
          const bg = line.startsWith('+') ? 'rgba(46,197,115,0.07)'
            : line.startsWith('-') ? 'rgba(232,69,69,0.07)'
            : 'transparent'
          return (
            <div key={i} style={{
              padding: '0 12px', color: c, background: bg,
              whiteSpace: 'pre',
            }}>{line || ' '}</div>
          )
        })}
      </pre>
    </div>
  )
}

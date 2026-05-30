import React, { useCallback, useMemo, useState } from 'react'
import { ipc, ChangelogEntry, ChangelogQuery } from '@/ipc'
import { ActionBtn } from '@/components/ui/ActionBtn'

interface ChangelogPanelProps {
  repoPath: string
}

type Mode = 'date' | 'commit'
type View = 'detailed' | 'discord'

function isoDay(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function todayIso(): string { return isoDay(Date.now()) }
function isoDaysAgo(n: number): string { return isoDay(Date.now() - n * 86400_000) }

function formatDayHeading(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}

function buildMarkdown(repoName: string, range: string, groups: { day: string; entries: ChangelogEntry[] }[]): string {
  const lines: string[] = []
  lines.push(`# Changelog — ${repoName}`)
  lines.push('')
  lines.push(`_${range}_`)
  lines.push('')
  for (const g of groups) {
    lines.push(`## ${formatDayHeading(g.day)}`)
    lines.push('')
    for (const e of g.entries) {
      lines.push(`- **${e.subject}** \`${e.hash.slice(0, 7)}\``)
      if (e.body.trim()) {
        const body = e.body.trim().split('\n').map(l => `  ${l}`).join('\n')
        lines.push(body)
      }
    }
    lines.push('')
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n'
}

/**
 * Discord-flavoured markdown: bold day headings, simple bullet list of
 * subjects, no SHAs, no per-commit bodies. Indented sub-bullets for any
 * non-empty body lines (Discord renders nested bullets with `  -`).
 */
function buildDiscord(repoName: string, range: string, groups: { day: string; entries: ChangelogEntry[] }[]): string {
  const lines: string[] = []
  lines.push(`**Changelog — ${repoName}**`)
  lines.push(`*${range}*`)
  lines.push('')
  for (const g of groups) {
    lines.push(`**${formatDayHeading(g.day)}**`)
    for (const e of g.entries) {
      const subject = (e.subject || '(no subject)').trim()
      lines.push(`- ${subject}`)
    }
    lines.push('')
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n'
}

export function ChangelogPanel({ repoPath }: ChangelogPanelProps) {
  const repoName = useMemo(() => repoPath.replace(/\\/g, '/').split('/').pop() ?? repoPath, [repoPath])

  const [mode, setMode] = useState<Mode>('date')
  const [fromDate, setFromDate] = useState<string>(isoDaysAgo(30))
  const [toDate, setToDate] = useState<string>(todayIso())
  const [fromCommit, setFromCommit] = useState<string>('')
  const [toCommit, setToCommit] = useState<string>('HEAD')
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [view, setView] = useState<View>('detailed')

  const canGenerate = mode === 'date'
    ? !!(fromDate && toDate) && fromDate <= toDate
    : !!fromCommit.trim()

  const groups = useMemo(() => {
    if (!entries) return []
    const map = new Map<string, ChangelogEntry[]>()
    for (const e of entries) {
      const day = isoDay(e.timestamp)
      const arr = map.get(day) ?? []
      arr.push(e)
      map.set(day, arr)
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))   // oldest day first
      .map(([day, entries]) => ({ day, entries }))
  }, [entries])

  const rangeLabel = useMemo(() => {
    if (mode === 'date') return `From ${fromDate} to ${toDate}`
    const to = toCommit.trim() || 'HEAD'
    return `From ${fromCommit.trim() || '?'} to ${to}`
  }, [mode, fromDate, toDate, fromCommit, toCommit])

  const generate = useCallback(async () => {
    setLoading(true)
    setError(null)
    setCopied(false)
    try {
      const q: ChangelogQuery = mode === 'date'
        ? { fromDate, toDate }
        : { fromCommit: fromCommit.trim(), toCommit: toCommit.trim() || 'HEAD' }
      const res = await ipc.changelog(repoPath, q)
      setEntries(res)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg.replace(/^PERMISSION_DENIED:\s*/, ''))
      setEntries(null)
    } finally {
      setLoading(false)
    }
  }, [mode, fromDate, toDate, fromCommit, toCommit, repoPath])

  const markdown = useMemo(
    () => entries && entries.length ? buildMarkdown(repoName, rangeLabel, groups) : '',
    [entries, groups, repoName, rangeLabel]
  )

  const discordText = useMemo(
    () => entries && entries.length ? buildDiscord(repoName, rangeLabel, groups) : '',
    [entries, groups, repoName, rangeLabel]
  )

  // Reset the "Copied ✓" affordance when switching views so the button label
  // doesn't lie about the most recent clipboard contents.
  React.useEffect(() => { setCopied(false) }, [view])

  const copyActive = useCallback(async () => {
    const text = view === 'discord' ? discordText : markdown
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setError('Failed to copy to clipboard')
    }
  }, [view, markdown, discordText])

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: '#0d0f15', padding: '22px 24px', fontFamily: 'var(--lg-font-ui)', display: 'flex', flexDirection: 'column', minHeight: '100%' }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#c8d0e8', letterSpacing: '-0.03em', lineHeight: 1 }}>
          Changelog
        </div>
        <div style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#344057', marginTop: 5 }}>
          {repoName} · admin
        </div>
      </div>

      {/* ── Configuration card ────────────────────────────────────────────── */}
      <div style={{
        background: '#131720', border: '1px solid #1a2030', borderRadius: 10,
        padding: 18, marginBottom: 16,
      }}>
        {/* Mode toggle */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          <ModeTab label="By date range"   active={mode === 'date'}   onClick={() => setMode('date')} />
          <ModeTab label="By commit range" active={mode === 'commit'} onClick={() => setMode('commit')} />
        </div>

        {mode === 'date' ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="From">
              <input
                type="date"
                value={fromDate}
                max={toDate || undefined}
                onChange={e => setFromDate(e.target.value)}
                style={inputStyle}
              />
            </Field>
            <Field label="To">
              <input
                type="date"
                value={toDate}
                min={fromDate || undefined}
                max={todayIso()}
                onChange={e => setToDate(e.target.value)}
                style={inputStyle}
              />
            </Field>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="From commit (exclusive)">
              <input
                type="text"
                value={fromCommit}
                onChange={e => setFromCommit(e.target.value)}
                placeholder="abc1234, v1.0.3, branch-name…"
                spellCheck={false}
                style={{ ...inputStyle, fontFamily: 'var(--lg-font-mono)' }}
              />
            </Field>
            <Field label="To commit (inclusive)">
              <input
                type="text"
                value={toCommit}
                onChange={e => setToCommit(e.target.value)}
                placeholder="HEAD"
                spellCheck={false}
                style={{ ...inputStyle, fontFamily: 'var(--lg-font-mono)' }}
              />
            </Field>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
          <div style={{ fontSize: 11, color: '#4a566a' }}>
            Excludes merge commits. Author identity is omitted.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <ActionBtn onClick={generate} disabled={!canGenerate || loading} size="sm">
              {loading ? 'Generating…' : 'Generate'}
            </ActionBtn>
            {entries && entries.length > 0 && (
              <ActionBtn onClick={copyActive} size="sm" ghost>
                {copied
                  ? 'Copied ✓'
                  : view === 'discord' ? 'Copy for Discord' : 'Copy Markdown'}
              </ActionBtn>
            )}
          </div>
        </div>

        {error && (
          <div style={{
            marginTop: 12, padding: '8px 12px', borderRadius: 6,
            background: 'rgba(232,64,64,0.08)', border: '1px solid rgba(232,64,64,0.25)',
            color: '#ff9090', fontSize: 12,
          }}>
            {error}
          </div>
        )}
      </div>

      {/* ── Output ─────────────────────────────────────────────────────────── */}
      {entries !== null && (
        <div style={{
          background: '#131720', border: '1px solid #1a2030', borderRadius: 10,
          padding: 20, flex: 1,
        }}>
          {entries.length === 0 ? (
            <div style={{ color: '#4a566a', fontSize: 13 }}>
              No commits in this range.
            </div>
          ) : (
            <>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 12, marginBottom: 14, paddingBottom: 10, borderBottom: '1px solid #1a2030',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ fontSize: 13, color: '#c8d0e8', fontWeight: 600 }}>
                    {entries.length} commit{entries.length === 1 ? '' : 's'}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <ViewTab label="Detailed" active={view === 'detailed'} onClick={() => setView('detailed')} />
                    <ViewTab label="Discord"  active={view === 'discord'}  onClick={() => setView('discord')} />
                  </div>
                </div>
                <div style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#4a566a' }}>
                  {rangeLabel}
                </div>
              </div>

              {view === 'detailed' ? (
                groups.map(g => (
                  <div key={g.day} style={{ marginBottom: 22 }}>
                    <div style={{
                      fontSize: 11, fontWeight: 700, color: '#a27ef0',
                      textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8,
                    }}>
                      {formatDayHeading(g.day)}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {g.entries.map(e => (
                        <div key={e.hash} style={{
                          background: 'rgba(255,255,255,0.015)',
                          border: '1px solid #18202e', borderRadius: 8,
                          padding: '10px 14px',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                            <span style={{ fontSize: 13, color: '#e6ebf5', fontWeight: 600, flex: 1, wordBreak: 'break-word' }}>
                              {e.subject || '(no subject)'}
                            </span>
                            <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#4a566a', flexShrink: 0 }}>
                              {e.hash.slice(0, 7)}
                            </span>
                          </div>
                          {e.body.trim() && (
                            <pre style={{
                              margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                              fontFamily: 'var(--lg-font-ui)', fontSize: 12, lineHeight: 1.5,
                              color: '#8b95a8',
                            }}>{e.body.trim()}</pre>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                /* Discord view — copy-ready raw markdown, monospace, selectable */
                <pre
                  onClick={e => {
                    // One-click select all to make grabbing the text effortless.
                    const range = document.createRange()
                    range.selectNodeContents(e.currentTarget)
                    const sel = window.getSelection()
                    sel?.removeAllRanges()
                    sel?.addRange(range)
                  }}
                  style={{
                    margin: 0, padding: '14px 16px',
                    background: '#0d1119', border: '1px solid #1f2738', borderRadius: 8,
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    fontFamily: 'var(--lg-font-mono)', fontSize: 12.5, lineHeight: 1.55,
                    color: '#c8d0e8', cursor: 'text', userSelect: 'text',
                  }}
                >{discordText}</pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Internals ────────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 30,
  padding: '0 10px',
  background: '#0d1119',
  border: '1px solid #1f2738',
  borderRadius: 6,
  color: '#c8d0e8',
  fontFamily: 'var(--lg-font-ui)',
  fontSize: 12.5,
  outline: 'none',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{
        fontSize: 10, fontWeight: 700, color: '#4a566a',
        textTransform: 'uppercase', letterSpacing: '0.1em',
      }}>{label}</span>
      {children}
    </label>
  )
}

function ModeTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 28, padding: '0 14px', borderRadius: 6,
        background: active ? 'rgba(var(--lg-accent-rgb), 0.15)' : 'transparent',
        border: `1px solid ${active ? 'rgba(var(--lg-accent-rgb), 0.4)' : '#1f2738'}`,
        color: active ? 'var(--lg-accent)' : '#5a6880',
        fontFamily: 'var(--lg-font-ui)', fontSize: 12, fontWeight: active ? 600 : 400,
        cursor: 'pointer', transition: 'background 0.12s, color 0.12s, border-color 0.12s',
      }}
    >
      {label}
    </button>
  )
}

function ViewTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 22, padding: '0 9px', borderRadius: 5,
        background: active ? 'rgba(var(--lg-accent-rgb), 0.15)' : 'transparent',
        border: `1px solid ${active ? 'rgba(var(--lg-accent-rgb), 0.4)' : '#1f2738'}`,
        color: active ? 'var(--lg-accent)' : '#5a6880',
        fontFamily: 'var(--lg-font-ui)', fontSize: 11, fontWeight: active ? 600 : 400,
        cursor: 'pointer', transition: 'background 0.12s, color 0.12s, border-color 0.12s',
      }}
    >
      {label}
    </button>
  )
}

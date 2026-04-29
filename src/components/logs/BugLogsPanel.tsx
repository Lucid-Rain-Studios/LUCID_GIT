import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ipc } from '@/ipc'

export function BugLogsPanel() {
  const [logText,    setLogText]    = useState<string>('')
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [saving,     setSaving]     = useState(false)
  const [savedPath,  setSavedPath]  = useState<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setSavedPath(null)
    try {
      const [text, hint] = await Promise.all([
        ipc.logGetText(),
        ipc.logGetSuggestion(),
      ])
      setLogText(text)
      setSuggestion(hint)
      // Scroll to bottom after render so the most recent entries are visible
      requestAnimationFrame(() => {
        if (preRef.current) {
          preRef.current.scrollTop = preRef.current.scrollHeight
        }
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleSave = async () => {
    setSaving(true)
    setSavedPath(null)
    try {
      const p = await ipc.logSaveDialog()
      if (p) setSavedPath(p)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
      background: 'var(--lg-bg-primary)',
      fontFamily: 'var(--lg-font-ui)',
    }}>
      {/* ── Header ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 16px',
        borderBottom: '1px solid var(--lg-border)',
        flexShrink: 0,
      }}>
        <LogIcon />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--lg-text-primary)', flex: 1 }}>
          Bug Logs
        </span>
        <span style={{ fontSize: 10, color: 'var(--lg-text-secondary)', opacity: 0.5 }}>
          Last 5 sessions
        </span>
        <button
          onClick={load}
          disabled={loading}
          title="Refresh log"
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            height: 26, padding: '0 10px',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid var(--lg-border)',
            borderRadius: 5, cursor: loading ? 'default' : 'pointer',
            color: 'var(--lg-text-secondary)', fontSize: 11,
            opacity: loading ? 0.4 : 1,
            transition: 'opacity 0.15s, background 0.15s',
          }}
          onMouseEnter={e => { if (!loading) e.currentTarget.style.background = 'rgba(255,255,255,0.07)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
        >
          <RefreshIcon spinning={loading} />
          Refresh
        </button>
      </div>

      {/* ── Log text area ── */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: 16, gap: 12, minHeight: 0 }}>
        <div style={{
          flex: 1, position: 'relative',
          background: 'var(--lg-bg-secondary)',
          border: '1px solid var(--lg-border)',
          borderRadius: 8, overflow: 'hidden',
          minHeight: 0,
        }}>
          {loading ? (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--lg-text-secondary)', fontSize: 11, opacity: 0.5,
            }}>
              Loading logs…
            </div>
          ) : (
            <pre
              ref={preRef}
              style={{
                margin: 0, padding: '12px 14px',
                height: '100%', overflow: 'auto',
                fontFamily: 'var(--lg-font-mono)', fontSize: 11,
                lineHeight: 1.7, whiteSpace: 'pre',
                color: 'var(--lg-text-secondary)',
                userSelect: 'text',
              }}
            >
              {logText || '(no log entries yet)'}
            </pre>
          )}
        </div>

        {/* ── Suggestion box ── */}
        {!loading && suggestion && (
          <div style={{
            flexShrink: 0,
            background: 'rgba(245, 158, 11, 0.08)',
            border: '1px solid rgba(245, 158, 11, 0.30)',
            borderRadius: 8,
            padding: '10px 14px',
            display: 'flex', gap: 10, alignItems: 'flex-start',
          }}>
            <LightbulbIcon />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(245,158,11,0.8)', marginBottom: 4 }}>
                Suggested Fix
              </div>
              <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.65, color: 'var(--lg-text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {suggestion}
              </p>
            </div>
          </div>
        )}

        {/* ── Footer actions ── */}
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              height: 30, padding: '0 14px',
              background: 'rgba(var(--lg-accent-rgb), 0.12)',
              border: '1px solid rgba(var(--lg-accent-rgb), 0.35)',
              borderRadius: 6, cursor: (saving || loading) ? 'default' : 'pointer',
              color: 'var(--lg-accent)', fontSize: 12, fontWeight: 500,
              opacity: (saving || loading) ? 0.5 : 1,
              transition: 'opacity 0.15s, background 0.15s',
            }}
            onMouseEnter={e => { if (!saving && !loading) e.currentTarget.style.background = 'rgba(var(--lg-accent-rgb), 0.2)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(var(--lg-accent-rgb), 0.12)' }}
          >
            <SaveIcon />
            {saving ? 'Saving…' : 'Save log as .txt'}
          </button>

          {savedPath && (
            <span style={{ fontSize: 11, color: 'var(--lg-text-secondary)', opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Saved to {savedPath}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Icons ──────────────────────────────────────────────────────────────────────

function LogIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: 'var(--lg-accent)', flexShrink: 0 }}>
      <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 5.5h6M5 8h6M5 10.5h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="11" height="11" viewBox="0 0 12 12" fill="none"
      style={{ flexShrink: 0, animation: spinning ? 'spin 1s linear infinite' : 'none' }}
    >
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <path d="M10 6a4 4 0 1 1-.8-2.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M9 2.5v2.5H11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function LightbulbIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ color: 'rgba(245,158,11,0.8)', flexShrink: 0, marginTop: 1 }}>
      <path d="M8 2a4 4 0 0 1 2.6 7.1c-.4.4-.6.9-.6 1.4v.5H6v-.5c0-.5-.2-1-.6-1.4A4 4 0 0 1 8 2Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6.5 13h3M7 14.5h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function SaveIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <path d="M3 13h10a1 1 0 0 0 1-1V5l-3-3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6 13V9h4v4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M5.5 3H10v2.5H5.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}

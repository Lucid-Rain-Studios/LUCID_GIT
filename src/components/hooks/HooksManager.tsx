import React, { useEffect, useState } from 'react'
import { ipc, HookInfo, BuiltinDef } from '@/ipc'
import { cn } from '@/lib/utils'

interface HooksManagerProps {
  repoPath: string
}

export function HooksManager({ repoPath }: HooksManagerProps) {
  const [hooks, setHooks]       = useState<HookInfo[]>([])
  const [builtins, setBuiltins] = useState<BuiltinDef[]>([])
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [busy, setBusy]         = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [h, b] = await Promise.all([
        ipc.hookList(repoPath),
        ipc.hookBuiltins(),
      ])
      setHooks(h)
      setBuiltins(b)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [repoPath])

  const toggle = async (hook: HookInfo) => {
    setBusy(hook.name)
    try {
      if (hook.enabled) {
        await ipc.hookDisable(repoPath, hook.name)
      } else {
        await ipc.hookEnable(repoPath, hook.name)
      }
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const install = async (id: string) => {
    setBusy(id)
    setError(null)
    try {
      await ipc.hookInstallBuiltin(repoPath, id)
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const toggleExpand = (key: string) =>
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // Which builtins are already installed
  const installedBuiltinIds = new Set(
    hooks.filter(h => h.isBuiltin).map(h => h.name)
  )

  return (
    <div className="flex-1 flex flex-col overflow-hidden text-[11px] font-mono">

      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="px-3 py-2 border-b border-lg-border shrink-0">
        {loading && (
          <span className="text-[10px] text-lg-text-secondary animate-pulse">Loading hooks…</span>
        )}
        {!loading && (
          <div className="flex items-center gap-3">
            <Stat label="Active" value={hooks.filter(h => h.enabled).length} />
            <Stat label="Disabled" value={hooks.filter(h => !h.enabled).length} />
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">

        {error && (
          <div className="mx-3 mt-2 px-3 py-2 bg-lg-error/10 border border-lg-error/40 rounded text-lg-error text-[10px]">
            {error}
          </div>
        )}

        {/* ── Installed hooks ──────────────────────────────────────── */}
        {hooks.length > 0 && (
          <Section label={`Installed hooks (${hooks.length})`}>
            {hooks.map(hook => (
              <div key={hook.name}>
                <div className="flex items-center gap-2 px-3 py-2 hover:bg-lg-bg-elevated transition-colors">
                  {/* Toggle */}
                  <button
                    onClick={() => toggle(hook)}
                    disabled={busy !== null}
                    title={hook.enabled ? 'Disable hook' : 'Enable hook'}
                    style={{
                      width: 32, height: 18, borderRadius: 9, flexShrink: 0,
                      background: hook.enabled ? '#2ec573' : '#252d42',
                      border: 'none', padding: 0, cursor: busy ? 'not-allowed' : 'pointer',
                      position: 'relative', transition: 'background 0.2s',
                      opacity: busy !== null ? 0.5 : 1,
                    }}
                  >
                    <span style={{
                      position: 'absolute', top: 3, width: 12, height: 12,
                      borderRadius: '50%', background: '#fff',
                      transition: 'left 0.2s',
                      left: hook.enabled ? 17 : 3,
                    }} />
                  </button>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className={cn(
                        'text-[11px]',
                        hook.enabled ? 'text-lg-text-primary' : 'text-lg-text-secondary line-through'
                      )}>
                        {hook.name}
                      </span>
                      {hook.isBuiltin && (
                        <span className="text-[9px] px-1 py-0.5 bg-lg-accent/20 text-lg-accent rounded">
                          builtin
                        </span>
                      )}
                    </div>
                  </div>

                  {hook.scriptPreview && (
                    <button
                      onClick={() => toggleExpand(hook.name)}
                      className="text-[9px] text-lg-text-secondary hover:text-lg-text-primary transition-colors"
                    >
                      {expanded.has(hook.name) ? '▲' : '▼'}
                    </button>
                  )}
                </div>

                {expanded.has(hook.name) && hook.scriptPreview && (
                  <pre className="mx-3 mb-2 p-2 bg-lg-bg-primary border border-lg-border rounded text-[9px] text-lg-text-secondary overflow-x-auto">
                    {hook.scriptPreview}
                  </pre>
                )}
              </div>
            ))}
          </Section>
        )}

        {hooks.length === 0 && !loading && (
          <div className="px-3 py-3 text-[10px] text-lg-text-secondary">
            No hooks installed in .git/hooks/
          </div>
        )}

        {/* ── Built-in library ─────────────────────────────────────── */}
        <Section label="Built-in library">
          <div className="px-3 py-1.5 text-[10px] text-lg-text-secondary">
            One-click install. Existing non-builtin hooks are backed up as <span className="text-lg-text-primary">.bak</span>.
          </div>
          {builtins.map(def => {
            const isInstalled = installedBuiltinIds.has(def.hookName)
            return (
              <div key={def.id} className="border-t border-lg-border/50">
                <div className="flex items-start gap-2 px-3 py-2">
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-lg-text-primary font-semibold">{def.id}</span>
                      <span className="text-[9px] text-lg-text-secondary">({def.hookName})</span>
                    </div>
                    <div className="text-[10px] text-lg-text-secondary leading-relaxed">
                      {def.description}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <button
                      onClick={() => install(def.id)}
                      disabled={busy !== null}
                      className={cn(
                        'px-2 h-6 rounded text-[10px] border transition-colors disabled:opacity-40',
                        isInstalled
                          ? 'border-lg-border text-lg-text-secondary hover:border-lg-warning hover:text-lg-warning'
                          : 'border-lg-accent text-lg-accent hover:bg-lg-accent/10'
                      )}
                    >
                      {busy === def.id ? '…' : isInstalled ? 'Reinstall' : 'Install'}
                    </button>
                    <button
                      onClick={() => toggleExpand(`builtin-${def.id}`)}
                      className="text-[9px] text-lg-text-secondary hover:text-lg-text-primary transition-colors"
                    >
                      {expanded.has(`builtin-${def.id}`) ? 'Hide script' : 'View script'}
                    </button>
                  </div>
                </div>
                {expanded.has(`builtin-${def.id}`) && (
                  <pre className="mx-3 mb-2 p-2 bg-lg-bg-primary border border-lg-border rounded text-[9px] text-lg-text-secondary overflow-x-auto max-h-40">
                    {def.script}
                  </pre>
                )}
              </div>
            )
          })}
        </Section>

        {/* ── Notes ────────────────────────────────────────────────── */}
        <Section label="Notes">
          <div className="px-3 py-2 space-y-1.5 text-[10px] text-lg-text-secondary">
            <p>Disabled hooks are renamed to <span className="text-lg-text-primary">hookname.disabled</span> and kept in place.</p>
            <p>Hook output is shown inline in the commit panel before the commit is finalized.</p>
            <p>Bypassing a failed hook requires explicit confirmation — never silent.</p>
          </div>
        </Section>

      </div>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <div className="px-3 py-2 border-t border-lg-border shrink-0">
        <button
          onClick={load}
          disabled={loading}
          className="w-full h-7 rounded text-[10px] border border-lg-border text-lg-text-secondary hover:border-lg-accent hover:text-lg-accent disabled:opacity-40 transition-colors"
        >
          {loading ? 'Loading…' : '↺ Refresh'}
        </button>
      </div>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-lg-border">
      <div className="px-3 py-1.5 bg-lg-bg-secondary sticky top-0 z-10">
        <span className="text-[10px] uppercase tracking-widest text-lg-text-secondary">{label}</span>
      </div>
      {children}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-widest text-lg-text-secondary">{label}</span>
      <span className="text-xs font-semibold text-lg-text-primary">{value}</span>
    </div>
  )
}

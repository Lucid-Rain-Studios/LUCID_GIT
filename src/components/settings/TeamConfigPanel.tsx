import React, { useCallback, useEffect, useState } from 'react'
import { ipc, TeamConfig } from '@/ipc'
import { ActionBtn } from '@/components/ui/ActionBtn'
import { SettingsError } from './SettingsError'
import { useDialogStore } from '@/stores/dialogStore'

interface TeamConfigPanelProps {
  repoPath: string
}

const DEFAULTS: TeamConfig = {
  lfsPatterns: [],
  webhookEvents: {},
  hookIds: [],
}

export function TeamConfigPanel({ repoPath }: TeamConfigPanelProps) {
  const [config, setConfig]         = useState<TeamConfig>(DEFAULTS)
  const [patternsText, setPatternsText] = useState('')
  const [hookIdsText, setHookIdsText]   = useState('')
  const [saving, setSaving]         = useState(false)
  const [saved, setSaved]           = useState(false)
  const [loaded, setLoaded]         = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoaded(false)
    setError(null)
    return ipc.teamConfigLoad(repoPath).then(c => {
      const cfg = c ?? DEFAULTS
      setConfig(cfg)
      setPatternsText(cfg.lfsPatterns.join('\n'))
      setHookIdsText(cfg.hookIds.join('\n'))
      setLoaded(true)
    }).catch(e => setError(`Could not load team settings: ${String(e)}`))
  }, [repoPath])
  useEffect(() => { load() }, [load])

  const handleSave = async () => {
    if (!loaded) return
    setSaving(true)
    setSaved(false)
    setError(null)
    const patterns = patternsText.split('\n').map(s => s.trim()).filter(Boolean)
    const hookIds  = hookIdsText.split('\n').map(s => s.trim()).filter(Boolean)
    const final: TeamConfig = { ...config, lfsPatterns: patterns, hookIds }
    try {
      await ipc.teamConfigSave(repoPath, final)
      setConfig(final)
      setSaved(true)
    } catch (e) { setError(`Could not save team settings: ${String(e)}. Retry Save.`) }
    finally { setSaving(false) }
  }

  const handleApply = async () => {
    const policy = { ...config, lfsPatterns: patternsText.split('\n').map(s => s.trim()).filter(Boolean), hookIds: hookIdsText.split('\n').map(s => s.trim()).filter(Boolean) }
    if (!await useDialogStore.getState().confirm({ title: 'Apply team policy locally?', message: 'This edits .gitattributes and installs managed hooks in this checkout.',
      detail: `LFS patterns: ${policy.lfsPatterns.join(', ') || 'none'}\nHooks: ${policy.hookIds.join(', ') || 'none'}\nWebhook events: ${Object.keys(policy.webhookEvents).join(', ') || 'none'}`, confirmLabel: 'Apply policy' })) return
    setSaving(true); setError(null)
    try { await ipc.teamConfigApply(repoPath, policy); setSaved(false) }
    catch (e) { setError(`Policy application stopped: ${String(e)}. Review local attributes and hooks before retrying.`) }
    finally { setSaving(false) }
  }

  if (!loaded) {
    if (error) return <SettingsError error={error} onRetry={load} />
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-[11px] font-mono text-lg-text-secondary animate-pulse">Loading…</span>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {error && <SettingsError error={error} />}
      <div className="flex-1 overflow-y-auto">

        <div className="border-b border-lg-border">
          <div className="px-3 py-1.5 bg-lg-bg-secondary sticky top-0 z-10">
            <span className="text-[10px] font-mono uppercase tracking-widest text-lg-text-secondary">Team config</span>
          </div>
          <div className="px-3 py-2.5 space-y-2">
            <p className="text-[10px] font-mono text-lg-text-secondary leading-relaxed">
              Saves to <span className="text-lg-accent font-semibold">.lucid-git/team-config.json</span> in your
              repository. Commit this file so teammates can review and apply the policy locally.
            </p>
          </div>
        </div>

        <div className="border-b border-lg-border">
          <div className="px-3 py-1.5 bg-lg-bg-secondary sticky top-0 z-10">
            <span className="text-[10px] font-mono uppercase tracking-widest text-lg-text-secondary">LFS patterns</span>
          </div>
          <div className="px-3 py-2.5 space-y-2">
            <p className="text-[10px] font-mono text-lg-text-secondary">One glob pattern per line. Apply policy adds these patterns to this checkout’s .gitattributes.</p>
            <textarea
              rows={6}
              value={patternsText}
              onChange={e => { setPatternsText(e.target.value); setSaved(false) }}
              placeholder={'*.uasset\n*.umap\n*.png\n*.fbx'}
              className="w-full bg-lg-bg-primary border border-lg-border rounded px-2 py-1.5 text-[11px] font-mono text-lg-text-primary placeholder-lg-text-secondary/40 focus:outline-none focus:border-lg-accent resize-none"
            />
          </div>
        </div>

        <div className="border-b border-lg-border">
          <div className="px-3 py-1.5 bg-lg-bg-secondary sticky top-0 z-10">
            <span className="text-[10px] font-mono uppercase tracking-widest text-lg-text-secondary">Recommended hooks</span>
          </div>
          <div className="px-3 py-2.5 space-y-2">
            <p className="text-[10px] font-mono text-lg-text-secondary">Built-in hook IDs to install using Apply policy. Existing user hooks are preserved.</p>
            <textarea
              rows={3}
              value={hookIdsText}
              onChange={e => { setHookIdsText(e.target.value); setSaved(false) }}
              placeholder={'file-size-guard\nuasset-lfs-check'}
              className="w-full bg-lg-bg-primary border border-lg-border rounded px-2 py-1.5 text-[11px] font-mono text-lg-text-primary placeholder-lg-text-secondary/40 focus:outline-none focus:border-lg-accent resize-none"
            />
          </div>
        </div>

        <div className="px-3 py-3 flex items-center gap-3">
          <ActionBtn
            onClick={handleSave}
            disabled={saving}
            size="sm"
            style={{ height: 28, paddingLeft: 16, paddingRight: 16, fontSize: 10, fontFamily: 'var(--lg-font-mono)', fontWeight: 600 }}
          >
            {saving ? 'Saving…' : 'Save & commit-ready'}
          </ActionBtn>
          <ActionBtn onClick={handleApply} disabled={saving} size="sm">Apply policy locally</ActionBtn>
          {saved && <span className="text-[10px] font-mono text-lg-success">✓ Saved — remember to commit .lucid-git/team-config.json</span>}
        </div>

      </div>
    </div>
  )
}

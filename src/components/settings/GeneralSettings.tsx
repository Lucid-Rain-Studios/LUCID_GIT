import React, { useEffect, useState } from 'react'
import { ipc, AppSettings } from '@/ipc'
import { cn } from '@/lib/utils'

const CONFIRM_BRANCH_KEY = 'lucid-git:confirm-branch-switch'

const DEFAULTS: AppSettings = {
  autoFetchIntervalMinutes: 15,
  defaultCloneDepth: 50,
  largeFileWarnMB: 100,
  scheduledCleanup: {
    enabled: false,
    frequencyDays: 7,
    includeGc: true,
    includePruneLfs: true,
  },
  fontFamily: 'IBM Plex Sans',
  fontSize: 13,
  uiDensity: 'normal',
  theme: 'dark',
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-lg-border">
      <div className="px-3 py-1.5 bg-lg-bg-secondary sticky top-0 z-10">
        <span className="text-[10px] font-mono uppercase tracking-widest text-lg-text-secondary">{title}</span>
      </div>
      <div className="px-3 py-2.5 space-y-3">
        {children}
      </div>
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[11px] font-mono text-lg-text-primary">{label}</div>
        {hint && <div className="text-[10px] font-mono text-lg-text-secondary mt-0.5">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

export function GeneralSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS)
  const [saved, setSaved]       = useState(false)
  const [saving, setSaving]     = useState(false)
  const [confirmBranchSwitch, setConfirmBranchSwitch] = useState(
    () => localStorage.getItem(CONFIRM_BRANCH_KEY) !== 'false'
  )

  useEffect(() => {
    ipc.settingsGet().then(setSettings).catch(() => {})
  }, [])

  const handleConfirmBranchToggle = (checked: boolean) => {
    setConfirmBranchSwitch(checked)
    if (checked) localStorage.removeItem(CONFIRM_BRANCH_KEY)
    else localStorage.setItem(CONFIRM_BRANCH_KEY, 'false')
  }

  const update = (patch: Partial<AppSettings>) => {
    setSettings(s => ({ ...s, ...patch }))
    setSaved(false)
  }

  const updateCleanup = (patch: Partial<AppSettings['scheduledCleanup']>) => {
    setSettings(s => ({ ...s, scheduledCleanup: { ...s.scheduledCleanup, ...patch } }))
    setSaved(false)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await ipc.settingsSave(settings)
      setSaved(true)
    } catch {}
    finally { setSaving(false) }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">

        <Section title="Sync">
          <Row label="Auto-fetch interval" hint="Automatically fetch remote changes in the background">
            <select
              value={settings.autoFetchIntervalMinutes}
              onChange={e => update({ autoFetchIntervalMinutes: Number(e.target.value) })}
              className="bg-lg-bg-primary border border-lg-border rounded px-2 py-1 text-[11px] font-mono text-lg-text-primary focus:outline-none focus:border-lg-accent"
            >
              <option value={0}>Disabled</option>
              <option value={5}>Every 5 min</option>
              <option value={15}>Every 15 min</option>
              <option value={30}>Every 30 min</option>
              <option value={60}>Every hour</option>
            </select>
          </Row>
        </Section>

        <Section title="Clone">
          <Row label="Default clone depth" hint="Number of commits to fetch. 0 = full history">
            <input
              type="number"
              min={0}
              max={10000}
              value={settings.defaultCloneDepth}
              onChange={e => update({ defaultCloneDepth: Number(e.target.value) })}
              className="w-20 bg-lg-bg-primary border border-lg-border rounded px-2 py-1 text-[11px] font-mono text-lg-text-primary focus:outline-none focus:border-lg-accent text-right"
            />
          </Row>
        </Section>

        <Section title="Large file warnings">
          <Row label="Warn threshold" hint="Show a warning when a staged file exceeds this size">
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                max={10000}
                value={settings.largeFileWarnMB}
                onChange={e => update({ largeFileWarnMB: Number(e.target.value) })}
                className="w-20 bg-lg-bg-primary border border-lg-border rounded px-2 py-1 text-[11px] font-mono text-lg-text-primary focus:outline-none focus:border-lg-accent text-right"
              />
              <span className="text-[10px] font-mono text-lg-text-secondary">MB</span>
            </div>
          </Row>
        </Section>

        <Section title="Scheduled cleanup">
          <Row label="Enable scheduled cleanup" hint="Run maintenance tasks automatically">
            <input
              type="checkbox"
              checked={settings.scheduledCleanup.enabled}
              onChange={e => updateCleanup({ enabled: e.target.checked })}
              className="accent-lg-accent"
            />
          </Row>
          {settings.scheduledCleanup.enabled && (
            <>
              <Row label="Run every">
                <select
                  value={settings.scheduledCleanup.frequencyDays}
                  onChange={e => updateCleanup({ frequencyDays: Number(e.target.value) })}
                  className="bg-lg-bg-primary border border-lg-border rounded px-2 py-1 text-[11px] font-mono text-lg-text-primary focus:outline-none focus:border-lg-accent"
                >
                  <option value={7}>Weekly</option>
                  <option value={14}>Every 2 weeks</option>
                  <option value={30}>Monthly</option>
                </select>
              </Row>
              <Row label="Run git gc">
                <input
                  type="checkbox"
                  checked={settings.scheduledCleanup.includeGc}
                  onChange={e => updateCleanup({ includeGc: e.target.checked })}
                  className="accent-lg-accent"
                />
              </Row>
              <Row label="Prune LFS cache">
                <input
                  type="checkbox"
                  checked={settings.scheduledCleanup.includePruneLfs}
                  onChange={e => updateCleanup({ includePruneLfs: e.target.checked })}
                  className="accent-lg-accent"
                />
              </Row>
            </>
          )}
        </Section>

        <Section title="Workflow">
          <Row label="Confirm before switching branches" hint="Show a confirmation dialog when switching branches from the top bar">
            <input
              type="checkbox"
              checked={confirmBranchSwitch}
              onChange={e => handleConfirmBranchToggle(e.target.checked)}
              className="accent-lg-accent"
            />
          </Row>
        </Section>

        <div className="px-3 py-3 flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className={cn(
              'px-4 h-7 rounded text-[10px] font-mono border transition-colors disabled:opacity-40',
              'border-lg-accent text-lg-accent hover:bg-lg-accent/10'
            )}
          >
            {saving ? 'Saving…' : 'Save settings'}
          </button>
          {saved && <span className="text-[10px] font-mono text-lg-success">✓ Saved</span>}
        </div>

      </div>
    </div>
  )
}

import React, { useEffect, useState } from 'react'
import { ipc, AppSettings, UpdateInfo } from '@/ipc'
import { cn } from '@/lib/utils'
import { ActionBtn } from '@/components/ui/ActionBtn'

const CONFIRM_BRANCH_KEY = 'lucid-git:confirm-branch-switch'

const DEFAULTS: AppSettings = {
  autoFetchIntervalMinutes: 5,
  updateCheckIntervalMinutes: 30,
  defaultCloneDepth: 50,
  largeFileWarnMB: 100,
  scheduledCleanup: {
    enabled: false,
    frequencyDays: 7,
    includeGc: true,
    includePruneLfs: true,
  },
  fontFamily: 'system-ui',
  fontSize: 13,
  uiDensity: 'normal',
  theme: 'dark',
  codeFontFamily: 'Menlo',
  fontWeight: 500,
  borderRadius: 'default',
  defaultBranchName: 'main',
  featureVisibility: {
    unreal: 'auto',
    lfs:    'auto',
  },
}

/** Broadcast so live UI (e.g. the sidebar) can react without a full reload. */
export const SETTINGS_CHANGED_EVENT = 'lucid-git:settings-changed'

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
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [downloadingUpdate, setDownloadingUpdate] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateReady, setUpdateReady] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<string>('')

  useEffect(() => {
    ipc.settingsGet().then(setSettings).catch(() => {})
  }, [])

  useEffect(() => {
    const unsubAvail = ipc.onUpdateAvailable((info) => {
      setUpdateInfo(info)
      setUpdateReady(false)
      setUpdateStatus(`Update ${info.version} is available.`)
    })
    const unsubReady = ipc.onUpdateReady(() => {
      setUpdateReady(true)
      setDownloadingUpdate(false)
      setUpdateStatus(`Update ${updateInfo?.version ?? ''} is downloaded and ready to install.`.trim())
    })
    return () => { unsubAvail(); unsubReady() }
  }, [updateInfo?.version])

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

  const updateFeatureVisibility = (patch: Partial<NonNullable<AppSettings['featureVisibility']>>) => {
    setSettings(s => ({
      ...s,
      featureVisibility: { ...(s.featureVisibility ?? DEFAULTS.featureVisibility!), ...patch },
    }))
    setSaved(false)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await ipc.settingsSave(settings)
      setSaved(true)
      window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT))
    } catch {}
    finally { setSaving(false) }
  }

  const handleCheckUpdates = async () => {
    setCheckingUpdates(true)
    setUpdateStatus('Checking for updates…')
    try {
      const result = await ipc.updateCheck()
      if (result.source === 'unavailable') {
        setUpdateStatus('No updates found.')
      } else if (!result.available) {
        setUpdateStatus('You are already on the latest version.')
      } else if (result.version) {
        setUpdateStatus(`Update ${result.version} is available.`)
      }
    } catch {
      setUpdateStatus('No updates found.')
    } finally {
      setCheckingUpdates(false)
    }
  }

  const handleDownloadUpdate = async () => {
    setDownloadingUpdate(true)
    setUpdateStatus('Downloading update…')
    try {
      await ipc.updateDownload()
    } catch {
      setDownloadingUpdate(false)
      setUpdateStatus('Update download failed. Try again.')
    }
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
              <option value={1}>Every 1 min</option>
              <option value={2}>Every 2 min</option>
              <option value={5}>Every 5 min</option>
              <option value={15}>Every 15 min</option>
              <option value={30}>Every 30 min</option>
              <option value={60}>Every hour</option>
            </select>
          </Row>
        </Section>

        <Section title="Features">
          <Row
            label="Unreal Engine tools"
            hint="Show the Unreal panel and asset tools. Auto shows them only when the repo has a .uproject."
          >
            <select
              value={settings.featureVisibility?.unreal ?? 'auto'}
              onChange={e => updateFeatureVisibility({ unreal: e.target.value as 'auto' | 'show' | 'hide' })}
              className="bg-lg-bg-primary border border-lg-border rounded px-2 py-1 text-[11px] font-mono text-lg-text-primary focus:outline-none focus:border-lg-accent"
            >
              <option value="auto">Auto (detect)</option>
              <option value="show">Always show</option>
              <option value="hide">Always hide</option>
            </select>
          </Row>
          <Row
            label="Git LFS tools"
            hint="Show the LFS panel. Auto shows it only when the repo tracks files with Git LFS."
          >
            <select
              value={settings.featureVisibility?.lfs ?? 'auto'}
              onChange={e => updateFeatureVisibility({ lfs: e.target.value as 'auto' | 'show' | 'hide' })}
              className="bg-lg-bg-primary border border-lg-border rounded px-2 py-1 text-[11px] font-mono text-lg-text-primary focus:outline-none focus:border-lg-accent"
            >
              <option value="auto">Auto (detect)</option>
              <option value="show">Always show</option>
              <option value="hide">Always hide</option>
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
          <Row
            label="Default branch name for new repositories"
            hint={"GitHub's default branch name is main. You may want to change it due to different workflows, or because your integrations still require the historical default branch name of master. These preferences will edit your global Git config file."}
          >
            <input
              type="text"
              value={settings.defaultBranchName ?? 'main'}
              onChange={e => update({ defaultBranchName: e.target.value.trim() || 'main' })}
              className="w-32 bg-lg-bg-primary border border-lg-border rounded px-2 py-1 text-[11px] font-mono text-lg-text-primary focus:outline-none focus:border-lg-accent"
            />
          </Row>
        </Section>

        <Section title="App updates">
          <Row
            label="Check automatically"
            hint="How often Lucid Git checks GitHub Releases for a newer build. A check also runs at startup."
          >
            <select
              value={settings.updateCheckIntervalMinutes}
              onChange={e => update({ updateCheckIntervalMinutes: Number(e.target.value) })}
              className="bg-lg-bg-primary border border-lg-border rounded px-2 py-1 text-[11px] font-mono text-lg-text-primary focus:outline-none focus:border-lg-accent"
            >
              <option value={5}>Every 5 min</option>
              <option value={10}>Every 10 min</option>
              <option value={30}>Every 30 min</option>
              <option value={60}>Every hour</option>
              <option value={240}>Every 4 hours</option>
            </select>
          </Row>
          <Row
            label="Check for updates"
            hint="Check GitHub Releases for a newer installed build."
          >
            <ActionBtn
              onClick={handleCheckUpdates}
              disabled={checkingUpdates}
              size="sm"
              style={{ height: 28, paddingLeft: 12, paddingRight: 12, fontSize: 10, fontFamily: 'var(--lg-font-mono)' }}
            >
              {checkingUpdates ? 'Checking…' : 'Check now'}
            </ActionBtn>
          </Row>

          {updateInfo && !updateReady && (
            <Row label={`Update ${updateInfo.version} available`}>
              <ActionBtn
                onClick={handleDownloadUpdate}
                disabled={downloadingUpdate}
                size="sm"
                style={{ height: 28, paddingLeft: 12, paddingRight: 12, fontSize: 10, fontFamily: 'var(--lg-font-mono)' }}
              >
                {downloadingUpdate ? 'Downloading…' : 'Download update'}
              </ActionBtn>
            </Row>
          )}

          {updateReady && (
            <Row label="Update ready to install">
              <ActionBtn
                onClick={() => ipc.updateInstall()}
                color="#2dbd6e"
                size="sm"
                style={{ height: 28, paddingLeft: 12, paddingRight: 12, fontSize: 10, fontFamily: 'var(--lg-font-mono)' }}
              >
                Restart & install
              </ActionBtn>
            </Row>
          )}

          {updateStatus && (
            <div className="text-[10px] font-mono text-lg-text-secondary">{updateStatus}</div>
          )}
        </Section>

        <div className="px-3 py-3 flex items-center gap-3">
          <ActionBtn
            onClick={handleSave}
            disabled={saving}
            size="sm"
            style={{ height: 28, paddingLeft: 16, paddingRight: 16, fontSize: 10, fontFamily: 'var(--lg-font-mono)', fontWeight: 600 }}
          >
            {saving ? 'Saving…' : 'Save settings'}
          </ActionBtn>
          {saved && <span className="text-[10px] font-mono text-lg-success">✓ Saved</span>}
        </div>

      </div>
    </div>
  )
}

import React, { useEffect, useRef, useState } from 'react'
import { ipc, AppSettings, UpdateInfo, TerminalProfile } from '@/ipc'
import { ActionBtn } from '@/components/ui/ActionBtn'
import { SettingsError } from './SettingsError'

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
  preferredTerminal: 'auto',
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

  const pendingPatch = useRef<Partial<AppSettings>>({})
  const [terminals, setTerminals] = useState<TerminalProfile[]>([])
  const [loaded, setLoaded] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const load = () => {
    setSettingsError(null)
    return ipc.settingsGet().then(s => { setSettings(s); setLoaded(true) })
      .catch(e => setSettingsError(`Could not load settings: ${String(e)}`))
  }

  useEffect(() => {
    load()
    ipc.listTerminals().then(setTerminals).catch(() => setTerminals([]))
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
    const unsubError = ipc.onUpdateError(message => { setDownloadingUpdate(false); setCheckingUpdates(false); setUpdateStatus('Update failed: ' + message + '. Retry the check or download.') })
    return () => { unsubAvail(); unsubReady(); unsubError() }
  }, [updateInfo?.version])

  const handleConfirmBranchToggle = (checked: boolean) => {
    setConfirmBranchSwitch(checked)
    if (checked) localStorage.removeItem(CONFIRM_BRANCH_KEY)
    else localStorage.setItem(CONFIRM_BRANCH_KEY, 'false')
  }

  const update = (patch: Partial<AppSettings>) => {
    pendingPatch.current = { ...pendingPatch.current, ...patch }
    setSettings(s => ({ ...s, ...patch }))
    setSaved(false)
  }

  const updateFeatureVisibility = (patch: Partial<NonNullable<AppSettings['featureVisibility']>>) => {
    pendingPatch.current.featureVisibility = { ...pendingPatch.current.featureVisibility, ...patch } as AppSettings['featureVisibility']
    setSettings(s => ({
      ...s,
      featureVisibility: { ...(s.featureVisibility ?? DEFAULTS.featureVisibility!), ...patch },
    }))
    setSaved(false)
  }

  const handleSave = async () => {
    if (!loaded) return
    setSaving(true)
    setSaved(false)
    setSettingsError(null)
    try {
      await ipc.settingsSave(pendingPatch.current)
      pendingPatch.current = {}
      setSaved(true)
      window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT))
    } catch (e) { setSettingsError(`Could not save settings: ${String(e)}. Retry Save.`) }
    finally { setSaving(false) }
  }

  const handleCheckUpdates = async () => {
    setCheckingUpdates(true)
    setUpdateStatus('Checking for updates…')
    try {
      const result = await ipc.updateCheck()
      if (result.source === 'unavailable') {
        setUpdateStatus('Update source is unavailable. Retry when the release feed is reachable.')
      } else if (result.source === 'dev') {
        setUpdateStatus('Update checks are unavailable in development builds.')
      } else if (!result.available) {
        setUpdateStatus('You are already on the latest version.')
      } else if (result.version) {
        setUpdateStatus(`Update ${result.version} is available.`)
      }
    } catch (error) {
      setUpdateStatus('Update check failed: ' + String(error) + '. Retry the check.')
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

  if (!loaded) return settingsError ? <SettingsError error={settingsError} onRetry={load} /> : <div className="p-3">Loading settings…</div>
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {settingsError && <SettingsError error={settingsError} />}
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

        <Section title="Terminal">
          <Row
            label="Open Terminal uses"
            hint="Which terminal the sidebar's Open Terminal button launches. Auto picks the first one installed."
          >
            <select
              value={settings.preferredTerminal ?? 'auto'}
              onChange={e => update({ preferredTerminal: e.target.value })}
              className="bg-lg-bg-primary border border-lg-border rounded px-2 py-1 text-[11px] font-mono text-lg-text-primary focus:outline-none focus:border-lg-accent"
            >
              <option value="auto">Auto (first installed)</option>
              {terminals.map(term => (
                <option key={term.id} value={term.id} disabled={!term.available}>
                  {term.available ? term.label : `${term.label} (not found)`}
                </option>
              ))}
            </select>
          </Row>
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

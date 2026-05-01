import React, { useEffect, useState } from 'react'
import { ipc, WebhookConfig } from '@/ipc'
import { cn } from '@/lib/utils'

interface WebhookPanelProps {
  repoPath: string
}

const DEFAULT_CONFIG: WebhookConfig = {
  url:     '',
  enabled: false,
  events: {
    fileLocked:            true,
    fileUnlocked:          true,
    mergeConflictDetected: true,
    pushToMain:            false,
    branchCreated:         false,
    forceUnlock:           true,
    largeFileWarning:      false,
    fatalError:            true,
    cleanupCompleted:      false,
    branchDeleted:         false,
  },
  mentionRoles: [],
  quietHours:   undefined,
}

const EVENT_LABELS: Record<keyof WebhookConfig['events'], string> = {
  fileLocked:            'File locked',
  fileUnlocked:          'File unlocked',
  mergeConflictDetected: 'Merge conflict detected',
  pushToMain:            'Push to main',
  branchCreated:         'Branch created',
  forceUnlock:           'Force unlock',
  largeFileWarning:      'Large file warning',
  fatalError:            'Fatal error',
  cleanupCompleted:      'Cleanup completed',
  branchDeleted:         'Branch deleted',
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

export function WebhookPanel({ repoPath }: WebhookPanelProps) {
  const [config, setConfig]     = useState<WebhookConfig>(DEFAULT_CONFIG)
  const [saving, setSaving]     = useState(false)
  const [saved, setSaved]       = useState(false)
  const [testing, setTesting]   = useState(false)
  const [testOk, setTestOk]     = useState<boolean | null>(null)
  const [rolesInput, setRolesInput] = useState('')
  const [quietStart, setQuietStart] = useState('')
  const [quietEnd, setQuietEnd]     = useState('')
  const [useQuiet, setUseQuiet]     = useState(false)

  // Load saved config on mount / repo change
  useEffect(() => {
    ipc.notificationList(repoPath).catch(() => {}) // warm up
    ipc.webhookLoad(repoPath)
      .then(saved => {
        if (!saved) return
        setConfig(saved)
        setRolesInput((saved.mentionRoles ?? []).join(', '))
        if (saved.quietHours) {
          setUseQuiet(true)
          setQuietStart(saved.quietHours.start)
          setQuietEnd(saved.quietHours.end)
        } else {
          setUseQuiet(false)
          setQuietStart('')
          setQuietEnd('')
        }
      })
      .catch(() => {})
  }, [repoPath])

  const updateEvent = (key: keyof WebhookConfig['events'], value: boolean) => {
    setConfig(c => ({ ...c, events: { ...c.events, [key]: value } }))
    setSaved(false)
  }

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    const roles = rolesInput.split(',').map(s => s.trim()).filter(Boolean)
    const finalConfig: WebhookConfig = {
      ...config,
      mentionRoles: roles.length > 0 ? roles : undefined,
      quietHours:   useQuiet && quietStart && quietEnd
        ? { start: quietStart, end: quietEnd }
        : undefined,
    }
    try {
      await ipc.webhookSave(repoPath, finalConfig)
      setConfig(finalConfig)
      setSaved(true)
    } catch (e) {
      console.error('Webhook save failed:', e)
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    if (!config.url.trim()) return
    setTesting(true)
    setTestOk(null)
    try {
      const ok = await ipc.webhookTest(config.url.trim())
      setTestOk(ok)
    } catch {
      setTestOk(false)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">

        {/* ── Discord webhook URL ────────────────────────────────────────────── */}
        <Section title="Discord webhook">
          <p className="text-[10px] font-mono text-lg-text-secondary leading-relaxed">
            Paste a Discord channel webhook URL to receive notifications for repository events.
          </p>

          <div className="flex items-center gap-2">
            <input
              type="url"
              placeholder="https://discord.com/api/webhooks/…"
              value={config.url}
              onChange={e => { setConfig(c => ({ ...c, url: e.target.value })); setSaved(false) }}
              className="flex-1 bg-lg-bg-primary border border-lg-border rounded px-2 py-1 text-[11px] font-mono text-lg-text-primary placeholder-lg-text-secondary/40 focus:outline-none focus:border-lg-accent transition-colors"
            />
            <button
              onClick={handleTest}
              disabled={testing || !config.url.trim()}
              className="px-2.5 h-7 rounded text-[10px] font-mono border border-lg-border text-lg-text-secondary hover:border-lg-accent hover:text-lg-accent disabled:opacity-40 transition-colors shrink-0"
            >
              {testing ? '…' : 'Test'}
            </button>
          </div>

          {testOk === true  && <p className="text-[10px] font-mono text-lg-success">✓ Test message sent successfully</p>}
          {testOk === false && <p className="text-[10px] font-mono text-lg-error">✗ Webhook test failed — check URL</p>}

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={e => { setConfig(c => ({ ...c, enabled: e.target.checked })); setSaved(false) }}
              className="accent-lg-accent"
            />
            <span className="text-[11px] font-mono text-lg-text-primary">Enable webhook</span>
          </label>
        </Section>

        {/* ── Events ─────────────────────────────────────────────────────────── */}
        <Section title="Events">
          <p className="text-[10px] font-mono text-lg-text-secondary leading-relaxed">
            Choose which events trigger a Discord message.
          </p>
          <div className="space-y-1.5">
            {(Object.keys(config.events) as (keyof WebhookConfig['events'])[]).map(key => (
              <label key={key} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.events[key]}
                  onChange={e => updateEvent(key, e.target.checked)}
                  className="accent-lg-accent"
                />
                <span className="text-[11px] font-mono text-lg-text-primary">
                  {EVENT_LABELS[key]}
                </span>
              </label>
            ))}
          </div>
        </Section>

        {/* ── Mention roles ──────────────────────────────────────────────────── */}
        <Section title="Mention roles (optional)">
          <p className="text-[10px] font-mono text-lg-text-secondary leading-relaxed">
            Discord role IDs to ping, comma-separated (e.g. 123456789, 987654321).
          </p>
          <input
            type="text"
            placeholder="Role IDs, comma-separated"
            value={rolesInput}
            onChange={e => { setRolesInput(e.target.value); setSaved(false) }}
            className="w-full bg-lg-bg-primary border border-lg-border rounded px-2 py-1 text-[11px] font-mono text-lg-text-primary placeholder-lg-text-secondary/40 focus:outline-none focus:border-lg-accent transition-colors"
          />
        </Section>

        {/* ── Quiet hours ────────────────────────────────────────────────────── */}
        <Section title="Quiet hours (optional)">
          <label className="flex items-center gap-2 cursor-pointer mb-1">
            <input
              type="checkbox"
              checked={useQuiet}
              onChange={e => { setUseQuiet(e.target.checked); setSaved(false) }}
              className="accent-lg-accent"
            />
            <span className="text-[11px] font-mono text-lg-text-primary">
              Suppress webhooks during quiet hours
            </span>
          </label>
          {useQuiet && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-lg-text-secondary shrink-0">From</span>
              <input
                type="time"
                value={quietStart}
                onChange={e => { setQuietStart(e.target.value); setSaved(false) }}
                className="bg-lg-bg-primary border border-lg-border rounded px-2 py-1 text-[11px] font-mono text-lg-text-primary focus:outline-none focus:border-lg-accent transition-colors"
              />
              <span className="text-[10px] font-mono text-lg-text-secondary shrink-0">to</span>
              <input
                type="time"
                value={quietEnd}
                onChange={e => { setQuietEnd(e.target.value); setSaved(false) }}
                className="bg-lg-bg-primary border border-lg-border rounded px-2 py-1 text-[11px] font-mono text-lg-text-primary focus:outline-none focus:border-lg-accent transition-colors"
              />
            </div>
          )}
        </Section>

        {/* ── Save ───────────────────────────────────────────────────────────── */}
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
          {saved && (
            <span className="text-[10px] font-mono text-lg-success">✓ Saved</span>
          )}
        </div>

      </div>
    </div>
  )
}

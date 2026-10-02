import React, { useEffect, useRef, useState } from 'react'
import { ipc, AppSettings, DesktopNotificationEvents, DesktopNotificationEvent } from '@/ipc'
import { ActionBtn } from '@/components/ui/ActionBtn'
import { SettingsError } from './SettingsError'

const DEFAULTS: DesktopNotificationEvents = {
  appUpdate:         true,
  prResolved:        true,
  forceUnlock:       true,
  operationComplete: true,
  fatalError:        true,
  conflictForecast:  false,
  lockOnDirtyFile:   false,
}

interface ToggleDef {
  id:    DesktopNotificationEvent
  label: string
  hint:  string
}

const TIER_1: ToggleDef[] = [
  {
    id:    'appUpdate',
    label: 'App update available',
    hint:  'A new Lucid Git release is ready to download.',
  },
  {
    id:    'prResolved',
    label: 'PR merged or closed',
    hint:  'A pull request you authored was accepted or rejected. Often actionable — you may need to unlock files.',
  },
  {
    id:    'forceUnlock',
    label: 'Your lock was released by someone else',
    hint:  'A teammate or admin released one of your file locks.',
  },
  {
    id:    'operationComplete',
    label: 'Long operation finished while window was unfocused',
    hint:  'Clone, push, pull, or LFS migrate that took longer than 5 seconds, only when you alt-tabbed away.',
  },
  {
    id:    'fatalError',
    label: 'Fatal error',
    hint:  'An uncaught exception was logged. Useful for catching silent crashes.',
  },
]

const TIER_2: ToggleDef[] = [
  {
    id:    'conflictForecast',
    label: 'Conflict forecast detected an overlap',
    hint:  'A teammate pushed work that touches files you have local changes on. Off by default — can be chatty.',
  },
  {
    id:    'lockOnDirtyFile',
    label: 'Someone locked a file you have changes on',
    hint:  'You won\'t be able to push that file later. Off by default — only fires when the locked file matches your dirty list.',
  },
]

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

function ToggleRow({
  label, hint, checked, onChange,
}: {
  label: string; hint: string; checked: boolean; onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-mono text-lg-text-primary">{label}</div>
        <div className="text-[10px] font-mono text-lg-text-secondary mt-0.5">{hint}</div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="accent-lg-accent mt-1 shrink-0"
      />
    </div>
  )
}

export function NotificationSettings() {
  const pendingEvents = useRef<Partial<DesktopNotificationEvents>>({})
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [saved,    setSaved]    = useState(false)
  const [saving,   setSaving]   = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = () => {
    setError(null)
    return ipc.settingsGet().then(setSettings).catch(e => setError(`Could not load notification settings: ${String(e)}`))
  }

  useEffect(() => {
    load()
  }, [])

  if (!settings) {
    if (error) return <SettingsError error={error} onRetry={load} />
    return (
      <div className="px-3 py-6 text-[11px] font-mono text-lg-text-secondary">
        Loading…
      </div>
    )
  }

  const events: DesktopNotificationEvents = {
    ...DEFAULTS,
    ...(settings.desktopNotificationEvents ?? {}),
  }

  const updateEvent = (id: DesktopNotificationEvent, value: boolean) => {
    pendingEvents.current[id] = value
    setSettings(s => s && {
      ...s,
      desktopNotificationEvents: { ...events, [id]: value },
    })
    setSaved(false)
  }

  const handleSave = async () => {
    if (!settings) return
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await ipc.settingsSave({
        desktopNotificationEvents: pendingEvents.current as DesktopNotificationEvents,
      })
      pendingEvents.current = {}
      setSaved(true)
    } catch (e) {
      setError(`Could not save notification settings: ${String(e)}. Retry Save.`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {error && <SettingsError error={error} />}
      <div className="flex-1 overflow-y-auto">

        <Section title="Recommended (high signal)">
          {TIER_1.map(t => (
            <ToggleRow
              key={t.id}
              label={t.label}
              hint={t.hint}
              checked={!!events[t.id]}
              onChange={v => updateEvent(t.id, v)}
            />
          ))}
        </Section>

        <Section title="Optional (can be noisy)">
          {TIER_2.map(t => (
            <ToggleRow
              key={t.id}
              label={t.label}
              hint={t.hint}
              checked={!!events[t.id]}
              onChange={v => updateEvent(t.id, v)}
            />
          ))}
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

        <div className="px-3 pb-4 text-[10px] font-mono text-lg-text-secondary">
          In-app notifications (the bell icon) always show every event regardless of these toggles.
          These switches only control OS-level desktop toasts.
        </div>

      </div>
    </div>
  )
}

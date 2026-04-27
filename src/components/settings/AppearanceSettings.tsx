import React, { useEffect, useRef, useState } from 'react'
import { ipc, AppSettings } from '@/ipc'
import {
  applyAppearanceSettings,
  THEMES, UI_FONTS, CODE_FONTS, FONT_WEIGHTS, BORDER_RADII, ACCENT_PRESETS,
} from '@/lib/appearance'

const DEFAULTS: Partial<AppSettings> = {
  fontFamily:     'IBM Plex Sans',
  fontSize:       13,
  uiDensity:      'normal',
  theme:          'dark',
  codeFontFamily: 'JetBrains Mono',
  fontWeight:     400,
  borderRadius:   'default',
  accentColor:    undefined,
}

const DENSITIES: { id: AppSettings['uiDensity']; label: string; desc: string }[] = [
  { id: 'compact',  label: 'Compact',  desc: '28px' },
  { id: 'normal',   label: 'Normal',   desc: '34px' },
  { id: 'relaxed',  label: 'Relaxed',  desc: '44px' },
]

export function AppearanceSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [saved,    setSaved]    = useState(false)
  const [saving,   setSaving]   = useState(false)
  const [customAccent, setCustomAccent] = useState('')
  const colorInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ipc.settingsGet().then(s => {
      const merged = { ...DEFAULTS as AppSettings, ...s }
      setSettings(merged)
      setCustomAccent(merged.accentColor ?? '')
    }).catch(() => {})
  }, [])

  if (!settings) return (
    <div style={{ padding: 24, fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: 'var(--lg-text-secondary)' }}>
      Loading…
    </div>
  )

  const update = (patch: Partial<AppSettings>) => {
    setSettings(s => {
      if (!s) return s
      const next = { ...s, ...patch }
      applyAppearanceSettings(next)
      return next
    })
    setSaved(false)
  }

  const handleSave = async () => {
    if (!settings) return
    setSaving(true)
    try { await ipc.settingsSave(settings); setSaved(true) } catch { /* ignore */ }
    finally { setSaving(false) }
  }

  const accent = settings.accentColor ?? (THEMES.find(t => t.id === settings.theme)?.vars['--lg-accent'] ?? '#e8622f')

  return (
    <div style={{ maxWidth: 600, padding: '20px 24px 32px' }}>

      {/* ── Theme ── */}
      <Section title="Theme">
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 8,
        }}>
          {THEMES.map(t => {
            const active = settings.theme === t.id
            return (
              <button
                key={t.id}
                onClick={() => update({ theme: t.id })}
                style={{
                  padding: '8px 6px 7px', borderRadius: 'var(--lg-radius)', cursor: 'pointer',
                  background: t.preview.bg,
                  border: `2px solid ${active ? accent : 'transparent'}`,
                  outline: active ? 'none' : '1px solid rgba(255,255,255,0.06)',
                  outlineOffset: 0,
                  transition: 'border-color 0.14s, outline-color 0.14s',
                  textAlign: 'center',
                }}
              >
                {/* Mini app preview */}
                <div style={{ display: 'flex', gap: 3, marginBottom: 6, height: 32 }}>
                  {/* Sidebar strip */}
                  <div style={{ width: 10, borderRadius: 2, background: t.preview.panel, flexShrink: 0 }}>
                    <div style={{ height: 2, margin: '4px 2px 2px', borderRadius: 1, background: t.preview.accent }} />
                    <div style={{ height: 2, margin: '2px', borderRadius: 1, background: 'rgba(255,255,255,0.12)' }} />
                    <div style={{ height: 2, margin: '2px', borderRadius: 1, background: 'rgba(255,255,255,0.08)' }} />
                    <div style={{ height: 2, margin: '2px', borderRadius: 1, background: 'rgba(255,255,255,0.06)' }} />
                  </div>
                  {/* Main area */}
                  <div style={{ flex: 1, borderRadius: 2, background: t.preview.panel, opacity: 0.7, display: 'flex', flexDirection: 'column', padding: '4px 3px', gap: 2 }}>
                    <div style={{ height: 3, borderRadius: 1, background: t.preview.accent, width: '70%', opacity: 0.9 }} />
                    <div style={{ height: 2, borderRadius: 1, background: 'rgba(255,255,255,0.15)', width: '90%' }} />
                    <div style={{ height: 2, borderRadius: 1, background: 'rgba(255,255,255,0.1)', width: '60%' }} />
                    <div style={{ height: 2, borderRadius: 1, background: 'rgba(255,255,255,0.08)', width: '80%' }} />
                  </div>
                </div>
                <div style={{
                  fontFamily: 'var(--lg-font-ui)', fontSize: 10,
                  fontWeight: active ? 600 : 400,
                  color: active ? accent : 'rgba(255,255,255,0.45)',
                  letterSpacing: '-0.01em',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {t.label}
                </div>
              </button>
            )
          })}
        </div>
      </Section>

      {/* ── Accent color ── */}
      <Section title="Accent Color">
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
          {ACCENT_PRESETS.map(color => {
            const active = settings.accentColor === color
            return (
              <button
                key={color}
                onClick={() => update({ accentColor: active ? undefined : color })}
                title={color}
                style={{
                  width: 24, height: 24, borderRadius: '50%', background: color,
                  border: active ? `2px solid #fff` : '2px solid transparent',
                  outline: active ? `2px solid ${color}` : '1px solid rgba(255,255,255,0.12)',
                  outlineOffset: 1,
                  cursor: 'pointer', transition: 'transform 0.1s, outline 0.1s',
                  transform: active ? 'scale(1.15)' : 'scale(1)',
                }}
              />
            )
          })}

          {/* Custom picker */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => colorInputRef.current?.click()}
              title="Custom color"
              style={{
                width: 24, height: 24, borderRadius: '50%',
                background: settings.accentColor && !ACCENT_PRESETS.includes(settings.accentColor)
                  ? settings.accentColor
                  : 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)',
                border: '2px solid transparent',
                outline: '1px solid rgba(255,255,255,0.2)',
                outlineOffset: 1,
                cursor: 'pointer',
              }}
            />
            <input
              ref={colorInputRef}
              type="color"
              value={customAccent || '#e8622f'}
              onChange={e => {
                setCustomAccent(e.target.value)
                update({ accentColor: e.target.value })
              }}
              style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
            />
          </div>

          {/* Clear override */}
          {settings.accentColor && (
            <button
              onClick={() => { update({ accentColor: undefined }); setCustomAccent('') }}
              style={{
                height: 24, paddingLeft: 8, paddingRight: 8, borderRadius: 4,
                background: 'transparent', border: '1px solid rgba(255,255,255,0.12)',
                color: 'var(--lg-text-secondary)', fontFamily: 'var(--lg-font-ui)', fontSize: 10,
                cursor: 'pointer',
              }}
            >
              Reset
            </button>
          )}
        </div>
        <div style={{ marginTop: 6, fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: 'var(--lg-text-secondary)' }}>
          Overrides the theme's default accent. Click a preset again to clear it.
        </div>
      </Section>

      {/* ── Typography ── */}
      <Section title="Typography">
        {/* Font family row */}
        <Row label="UI font">
          <select
            value={settings.fontFamily}
            onChange={e => update({ fontFamily: e.target.value })}
            style={selectStyle}
          >
            {UI_FONTS.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </Row>

        {/* Code font row */}
        <Row label="Code font">
          <select
            value={settings.codeFontFamily ?? 'JetBrains Mono'}
            onChange={e => update({ codeFontFamily: e.target.value })}
            style={selectStyle}
          >
            {CODE_FONTS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </Row>

        {/* Font size */}
        <Row label="Font size">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="range" min={11} max={18} step={1}
              value={settings.fontSize}
              onChange={e => update({ fontSize: Number(e.target.value) })}
              style={{ width: 100, accentColor: 'var(--lg-accent)' }}
            />
            <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: 'var(--lg-text-secondary)', width: 32, textAlign: 'right' }}>
              {settings.fontSize}px
            </span>
          </div>
        </Row>

        {/* Font weight */}
        <Row label="Font weight">
          <ButtonGroup>
            {FONT_WEIGHTS.map(w => (
              <ChipBtn
                key={w.id}
                active={settings.fontWeight === w.id}
                onClick={() => update({ fontWeight: w.id })}
              >
                {w.label}
              </ChipBtn>
            ))}
          </ButtonGroup>
        </Row>

        {/* Preview */}
        <div style={{
          marginTop: 10, padding: '12px 14px',
          background: 'var(--lg-bg-elevated)', border: '1px solid var(--lg-border)', borderRadius: 'var(--lg-radius)',
        }}>
          <div style={{
            fontFamily: `'${settings.fontFamily}', system-ui`,
            fontSize: settings.fontSize,
            fontWeight: settings.fontWeight ?? 400,
            color: 'var(--lg-text-primary)', marginBottom: 5,
          }}>
            The quick brown fox jumps over the lazy dog
          </div>
          <div style={{
            fontFamily: `'${settings.codeFontFamily ?? 'JetBrains Mono'}', monospace`,
            fontSize: (settings.fontSize ?? 13) - 1,
            color: 'var(--lg-accent-blue)',
          }}>
            git commit -m "fix: resolve merge conflict"
          </div>
        </div>
      </Section>

      {/* ── Layout ── */}
      <Section title="Layout">
        <Row label="Density">
          <ButtonGroup>
            {DENSITIES.map(d => (
              <ChipBtn
                key={d.id}
                active={settings.uiDensity === d.id}
                onClick={() => update({ uiDensity: d.id })}
                title={d.desc}
              >
                {d.label}
              </ChipBtn>
            ))}
          </ButtonGroup>
        </Row>

        <Row label="Corner radius">
          <ButtonGroup>
            {BORDER_RADII.map(r => (
              <ChipBtn
                key={r.id}
                active={settings.borderRadius === r.id}
                onClick={() => update({ borderRadius: r.id })}
                title={r.px}
              >
                {r.label}
              </ChipBtn>
            ))}
          </ButtonGroup>
        </Row>
      </Section>

      {/* Save */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
        <SaveBtn label={saving ? 'Saving…' : 'Save'} disabled={saving} onClick={handleSave} />
        {saved && (
          <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#2ec573' }}>
            ✓ Saved
          </span>
        )}
        <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: 'var(--lg-text-secondary)', marginLeft: 'auto' }}>
          Changes preview instantly — save to persist
        </span>
      </div>
    </div>
  )
}

// ── Reusable pieces ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 26 }}>
      <div style={{
        fontFamily: 'var(--lg-font-ui)', fontSize: 10, fontWeight: 600,
        color: 'var(--lg-text-secondary)', letterSpacing: '0.12em', textTransform: 'uppercase',
        marginBottom: 10,
      }}>{title}</div>
      {children}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 12 }}>
      <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 13, color: 'var(--lg-text-primary)', flexShrink: 0 }}>
        {label}
      </div>
      {children}
    </div>
  )
}

function ButtonGroup({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 4 }}>{children}</div>
}

function ChipBtn({ active, onClick, children, title }: {
  active: boolean; onClick: () => void; children: React.ReactNode; title?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        height: 28, paddingLeft: 12, paddingRight: 12, borderRadius: 'var(--lg-radius)',
        background: active ? 'rgba(255,255,255,0.07)' : 'transparent',
        border: `1px solid ${active ? 'var(--lg-accent)' : 'var(--lg-border-strong)'}`,
        color: active ? 'var(--lg-accent)' : 'var(--lg-text-secondary)',
        fontFamily: 'var(--lg-font-ui)', fontSize: 12, fontWeight: active ? 600 : 400,
        cursor: 'pointer', transition: 'all 0.12s',
      }}
    >{children}</button>
  )
}

function SaveBtn({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 32, paddingLeft: 20, paddingRight: 20, borderRadius: 'var(--lg-radius)',
        background: hover ? 'rgba(232,98,47,0.2)' : 'rgba(232,98,47,0.12)',
        border: '1px solid rgba(232,98,47,0.5)',
        color: 'var(--lg-accent)', fontFamily: 'var(--lg-font-ui)', fontSize: 13, fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1, transition: 'all 0.12s',
      }}
    >{label}</button>
  )
}

const selectStyle: React.CSSProperties = {
  background: 'var(--lg-bg-elevated)', border: '1px solid var(--lg-border-strong)', borderRadius: 5,
  padding: '5px 10px', fontFamily: 'var(--lg-font-ui)', fontSize: 12,
  color: 'var(--lg-text-primary)', outline: 'none', cursor: 'pointer', minWidth: 160,
}

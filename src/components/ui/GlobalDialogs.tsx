import React, { useEffect, useRef, useState } from 'react'
import { useDialogStore, ConfirmOpts, PromptOpts, AlertOpts } from '@/stores/dialogStore'
import { useDialogOverlayDismiss } from '@/lib/useDialogOverlayDismiss'

// ── Backdrop + panel shell ─────────────────────────────────────────────────────

function Backdrop({ children, onDismiss, title }: { children: React.ReactNode; onDismiss: () => void; title: string }) {
  const modal = useDialogOverlayDismiss(onDismiss, true, title)
  return (
    <div {...modal} style={{
      position: 'fixed', inset: 0, zIndex: 600,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {children}
    </div>
  )
}

function Panel({ children, width = 400 }: { children: React.ReactNode; width?: number }) {
  return (
    <div style={{
      width, background: 'var(--lg-bg-elevated)',
      border: '1px solid var(--lg-border)', borderRadius: 12,
      boxShadow: '0 24px 64px rgba(0,0,0,0.75), 0 4px 20px rgba(0,0,0,0.5)',
      animation: 'slide-down 0.16s ease both',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {children}
    </div>
  )
}

const BTN_BASE: React.CSSProperties = {
  height: 30, paddingLeft: 16, paddingRight: 16, borderRadius: 6,
  fontFamily: 'var(--lg-font-ui)', fontSize: 12.5, fontWeight: 500,
  cursor: 'pointer', border: '1px solid transparent',
}

function CancelBtn({ label = 'Cancel', onClick }: { label?: string; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      data-dialog-cancel
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...BTN_BASE, background: 'transparent', borderColor: hover ? '#283047' : 'var(--lg-border)', color: hover ? 'var(--lg-text-primary)' : 'var(--lg-text-secondary)' }}
    >{label}</button>
  )
}

function ConfirmBtn({ label = 'Confirm', danger = false, onClick, autoFocus = false }: {
  label?: string; danger?: boolean; onClick: () => void; autoFocus?: boolean
}) {
  const [hover, setHover] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])
  const c = danger ? '#e84040' : '#4a9eff'
  return (
    <button
      ref={ref}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...BTN_BASE, background: hover ? `${c}28` : `${c}16`, borderColor: hover ? `${c}88` : `${c}44`, color: c, fontWeight: 600 }}
    >{label}</button>
  )
}

function DialogTitle({ title, danger }: { title: string; danger?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '16px 18px 0' }}>
      {danger && <DangerIcon />}
      <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 14, fontWeight: 600, color: 'var(--lg-text-primary)', letterSpacing: '-0.01em' }}>
        {title}
      </span>
    </div>
  )
}

function DialogMessage({ message, detail }: { message?: string; detail?: string }) {
  if (!message && !detail) return null
  return (
    <div style={{ padding: '10px 18px 0' }}>
      {message && (
        <p style={{ margin: 0, fontFamily: 'var(--lg-font-ui)', fontSize: 12.5, color: 'var(--lg-text-secondary)', lineHeight: 1.6 }}>
          {message}
        </p>
      )}
      {detail && (
        <p style={{ margin: '6px 0 0', fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: 'var(--lg-text-secondary)', opacity: 0.7, lineHeight: 1.5 }}>
          {detail}
        </p>
      )}
    </div>
  )
}

// ── Confirm dialog ─────────────────────────────────────────────────────────────

function ConfirmModal({ opts, onConfirm, onCancel }: {
  opts: ConfirmOpts; onConfirm: () => void; onCancel: () => void
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <Backdrop onDismiss={onCancel} title={opts.title}>
      <Panel>
        <DialogTitle title={opts.title} danger={opts.danger} />
        <DialogMessage message={opts.message} detail={opts.detail} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 18px 16px' }}>
          <CancelBtn label={opts.cancelLabel} onClick={onCancel} />
          <ConfirmBtn label={opts.confirmLabel ?? 'Confirm'} danger={opts.danger} onClick={onConfirm} autoFocus={!opts.danger} />
        </div>
      </Panel>
    </Backdrop>
  )
}

// ── Prompt dialog ──────────────────────────────────────────────────────────────

function PromptModal({ opts, onConfirm, onCancel }: {
  opts: PromptOpts; onConfirm: (v: string) => void; onCancel: () => void
}) {
  const [value, setValue] = useState(opts.defaultValue ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <Backdrop onDismiss={onCancel} title={opts.title}>
      <Panel>
        <DialogTitle title={opts.title} />
        <DialogMessage message={opts.message} />
        <div style={{ padding: '12px 18px 0' }}>
          <input
            ref={inputRef}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onConfirm(value) } }}
            placeholder={opts.placeholder}
            style={{
              width: '100%', boxSizing: 'border-box',
              height: 32, padding: '0 10px',
              background: 'var(--lg-bg-primary)', border: '1px solid var(--lg-border)',
              borderRadius: 6, outline: 'none',
              fontFamily: 'var(--lg-font-ui)', fontSize: 13,
              color: 'var(--lg-text-primary)',
            }}
            onFocus={e => { e.currentTarget.style.borderColor = 'rgba(var(--lg-accent-rgb), 0.5)' }}
            onBlur={e  => { e.currentTarget.style.borderColor = 'var(--lg-border)' }}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px 16px' }}>
          <CancelBtn onClick={onCancel} />
          <ConfirmBtn label={opts.confirmLabel ?? 'OK'} onClick={() => onConfirm(value)} />
        </div>
      </Panel>
    </Backdrop>
  )
}

// ── Alert dialog ───────────────────────────────────────────────────────────────

function AlertModal({ opts, onClose }: { opts: AlertOpts; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <Backdrop onDismiss={onClose} title={opts.title}>
      <Panel>
        <DialogTitle title={opts.title} />
        <DialogMessage message={opts.message} detail={opts.detail} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 18px 16px' }}>
          <ConfirmBtn label="OK" onClick={onClose} autoFocus />
        </div>
      </Panel>
    </Backdrop>
  )
}

// ── Root renderer ──────────────────────────────────────────────────────────────

export function GlobalDialogs() {
  const { pending, settle } = useDialogStore()
  if (!pending) return null
  if (pending.kind === 'confirm') return <ConfirmModal opts={pending.opts} onConfirm={() => settle(true)}  onCancel={() => settle(false)} />
  if (pending.kind === 'prompt')  return <PromptModal  opts={pending.opts} onConfirm={v  => settle(v)}     onCancel={() => settle(null)} />
  if (pending.kind === 'alert')   return <AlertModal   opts={pending.opts} onClose={() => settle(undefined)} />
  return null
}

// ── Icons ──────────────────────────────────────────────────────────────────────

function DangerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <path d="M8 1.5L14.5 13H1.5L8 1.5Z" stroke="#e84040" strokeWidth="1.3" strokeLinejoin="round" fill="rgba(232,64,64,0.12)" />
      <path d="M8 6v3.5" stroke="#e84040" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.5" r="0.75" fill="#e84040" />
    </svg>
  )
}

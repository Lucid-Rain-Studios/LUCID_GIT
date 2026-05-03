import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom'

interface DisabledTipState {
  reason: string
  x: number
  y: number
}

function inferDisabledReason(button: HTMLButtonElement): string {
  const explicit = button.dataset.disabledReason || button.getAttribute('aria-disabled-reason') || button.getAttribute('title')
  if (explicit?.trim()) return explicit.trim()

  const label = (button.textContent ?? button.getAttribute('aria-label') ?? '').trim().toLowerCase()
  if (label.includes('fetch')) return 'Operation in progress'
  if (label.includes('pull') || label.includes('merge')) return 'Nothing to merge'
  if (label.includes('push')) return 'Nothing to push'
  if (label.includes('commit')) return 'Select files and enter a commit message'
  if (label.includes('save')) return 'Complete required fields first'
  if (label.includes('unlock')) return 'Unlock is already in progress'
  if (label.includes('create pr')) return 'Nothing to publish'

  return 'This action is unavailable right now'
}

export function DisabledButtonTooltip() {
  const [tip, setTip] = useState<DisabledTipState | null>(null)

  useEffect(() => {
    const show = (event: PointerEvent) => {
      const target = event.target as Element | null
      const button = target?.closest('button:disabled') as HTMLButtonElement | null
      if (!button) return

      setTip({
        reason: inferDisabledReason(button),
        x: event.clientX,
        y: event.clientY,
      })
    }

    const move = (event: PointerEvent) => {
      setTip(current => current ? { ...current, x: event.clientX, y: event.clientY } : null)
    }

    const hide = (event?: PointerEvent) => {
      const related = event?.relatedTarget as Element | null
      if (related?.closest('button:disabled')) return
      setTip(null)
    }
    const hideOnScroll = () => hide()

    document.addEventListener('pointerover', show, true)
    document.addEventListener('pointermove', move, true)
    document.addEventListener('pointerout', hide, true)
    document.addEventListener('scroll', hideOnScroll, true)
    return () => {
      document.removeEventListener('pointerover', show, true)
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('pointerout', hide, true)
      document.removeEventListener('scroll', hideOnScroll, true)
    }
  }, [])

  if (!tip) return null

  return ReactDOM.createPortal(
    <div
      style={{
        position: 'fixed',
        left: tip.x + 10,
        top: tip.y + 12,
        zIndex: 10000,
        maxWidth: 260,
        background: '#1a2030',
        border: '1px solid #2f3a54',
        borderRadius: 5,
        padding: '4px 9px',
        color: '#c4cad8',
        fontFamily: "'IBM Plex Sans', system-ui",
        fontSize: 11,
        lineHeight: 1.4,
        pointerEvents: 'none',
        boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
      }}
    >
      {tip.reason}
    </div>,
    document.body,
  )
}

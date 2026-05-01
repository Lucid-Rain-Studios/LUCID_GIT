import React, { useEffect } from 'react'
import { useStatusToastStore } from '@/stores/statusToastStore'

const TOAST_DURATION_MS = 3200

export function StatusToastStack() {
  const { toasts, remove } = useStatusToastStore()

  useEffect(() => {
    const timers = toasts.map(toast => window.setTimeout(() => remove(toast.id), TOAST_DURATION_MS))
    return () => timers.forEach(t => window.clearTimeout(t))
  }, [toasts, remove])

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[1200] flex flex-col gap-2 pointer-events-none">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className="px-4 py-2 rounded-md border border-lg-accent/40 bg-lg-bg-elevated text-[11px] font-mono text-lg-text-primary shadow-2xl"
        >
          {toast.message}
        </div>
      ))}
    </div>
  )
}

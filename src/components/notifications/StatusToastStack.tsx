import React, { useEffect } from 'react'
import { useStatusToastStore } from '@/stores/statusToastStore'

const TOAST_DURATION_MS = 3200

export function StatusToastStack() {
  const { toasts, remove } = useStatusToastStore()

  useEffect(() => {
    const timers = toasts.map(toast => window.setTimeout(() => remove(toast.id), toast.durationMs ?? TOAST_DURATION_MS))
    return () => timers.forEach(t => window.clearTimeout(t))
  }, [toasts, remove])

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-14 left-1/2 -translate-x-1/2 z-[1200] flex flex-col gap-2 pointer-events-none">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className="flex items-center gap-3 pl-4 pr-2 py-2 rounded-xl border border-[#8ab4ff4d] bg-[rgba(8,24,58,0.66)] text-[11px] font-mono text-[#e8f1ff] shadow-2xl backdrop-blur-sm animate-[top-toast-slide_260ms_ease-out] pointer-events-auto"
        >
          <span>{toast.message}</span>
          {toast.action && (
            <button
              onClick={() => { toast.action!.onClick(); remove(toast.id) }}
              className="px-2.5 py-1 rounded-lg border border-[#8ab4ff66] bg-[#8ab4ff1f] text-[#cfe0ff] font-semibold hover:bg-[#8ab4ff33] transition-colors shrink-0"
            >
              {toast.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

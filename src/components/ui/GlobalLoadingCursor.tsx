import React, { useEffect, useState } from 'react'
import { useOperationStore } from '@/stores/operationStore'

/**
 * Displays a small spinner near the mouse cursor whenever the global operation
 * runner is active (same condition as the bottom status loading bar).
 */
export function GlobalLoadingCursor() {
  const isRunning = useOperationStore(s => s.isRunning)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  useEffect(() => {
    if (!isRunning) return

    const onMove = (e: MouseEvent) => setPos({ x: e.clientX, y: e.clientY })
    window.addEventListener('mousemove', onMove)

    const prevCursor = document.body.style.cursor
    document.body.style.cursor = 'progress'

    return () => {
      window.removeEventListener('mousemove', onMove)
      document.body.style.cursor = prevCursor
    }
  }, [isRunning])

  if (!isRunning) return null

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        left: pos.x + 14,
        top: pos.y + 14,
        width: 14,
        height: 14,
        borderRadius: '50%',
        border: '2px solid rgba(232,98,47,0.25)',
        borderTopColor: '#e8622f',
        animation: 'spin 0.8s linear infinite',
        pointerEvents: 'none',
        zIndex: 9999,
      }}
    />
  )
}

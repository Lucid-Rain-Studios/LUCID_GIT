import React, { useEffect } from 'react'
import { ipc } from './ipc'
import { applyAppearanceSettings } from './lib/appearance'
import { AppShell } from './components/layout/AppShell'
import { DisabledButtonTooltip } from './components/ui/DisabledButtonTooltip'

export function App() {
  useEffect(() => {
    ipc.settingsGet().then(applyAppearanceSettings).catch(() => {})

    // Prevent unhandled promise rejections from silently crashing the renderer
    const onUnhandled = (e: PromiseRejectionEvent) => {
      console.error('[Unhandled rejection]', e.reason)
      e.preventDefault()
    }
    const onError = (e: ErrorEvent) => {
      console.error('[Uncaught error]', e.message)
    }
    window.addEventListener('unhandledrejection', onUnhandled)
    window.addEventListener('error', onError)
    return () => {
      window.removeEventListener('unhandledrejection', onUnhandled)
      window.removeEventListener('error', onError)
    }
  }, [])

  return (
    <>
      <AppShell />
      <DisabledButtonTooltip />
    </>
  )
}

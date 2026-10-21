import React, { useEffect } from 'react'
import { ipc, logUiError } from './ipc'
import { applyAppearanceSettings } from './lib/appearance'
import { AppShell } from './components/layout/AppShell'
import { DisabledButtonTooltip } from './components/ui/DisabledButtonTooltip'
import { MergeWindow } from './components/merge/MergeWindow'

export function App() {
  useEffect(() => {
    ipc.settingsGet().then(applyAppearanceSettings).catch(() => {})

    // Prevent unhandled promise rejections from silently crashing the renderer
    const onUnhandled = (e: PromiseRejectionEvent) => {
      console.error('[Unhandled rejection]', e.reason)
      logUiError('renderer.unhandledRejection', 'Unhandled promise rejection', { reason: e.reason })
      e.preventDefault()
    }
    const onError = (e: ErrorEvent) => {
      console.error('[Uncaught error]', e.message)
      logUiError('renderer.uncaughtError', e.message || 'Uncaught renderer error', {
        filename: e.filename,
        lineno: e.lineno,
        colno: e.colno,
        error: e.error,
      })
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
      {new URLSearchParams(window.location.search).get('window') === 'merge' ? <MergeWindow /> : <AppShell />}
      <DisabledButtonTooltip />
    </>
  )
}

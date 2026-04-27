import React, { useEffect } from 'react'
import { ipc } from './ipc'
import { applyAppearanceSettings } from './lib/appearance'
import { AppShell } from './components/layout/AppShell'

export function App() {
  useEffect(() => {
    ipc.settingsGet().then(applyAppearanceSettings).catch(() => {})
  }, [])

  return <AppShell />
}

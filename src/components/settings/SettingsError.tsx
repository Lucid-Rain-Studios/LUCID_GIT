import React from 'react'

export function SettingsError({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return <div role="alert" className="p-3 text-[11px] font-mono text-lg-error">
    {error}
    {onRetry && <button className="ml-3 underline" onClick={onRetry}>Retry</button>}
  </div>
}

import React, { useEffect, useState } from 'react'
import { ipc } from '@/ipc'
import type { MergeWindowContext } from '../../../electron/mergeWindowTypes'
import { useRepoStore } from '@/stores/repoStore'
import { useOperationStore } from '@/stores/operationStore'
import { useDialogStore } from '@/stores/dialogStore'
import { MergePreviewDialog } from './MergeDialog'
import { GlobalDialogs } from '@/components/ui/GlobalDialogs'
import { GlobalLoadingCursor } from '@/components/ui/GlobalLoadingCursor'
import { StatusBar } from '@/components/layout/StatusBar'
import { PanelErrorBoundary } from '@/components/ui/PanelErrorBoundary'

export function MergeWindow() {
  const [context, setContext] = useState<MergeWindowContext | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let mounted = true
    void ipc.mergeWindowContext().then(value => {
      if (!mounted) return
      // Hydrate only the state this surface needs. Opening a repository here
      // would start a second set of watchers and background services.
      useRepoStore.setState({ repoPath: value.repoPath, currentBranch: value.currentBranch })
      setContext(value)
    }).catch(e => { if (mounted) setError(String(e)) })
    const unsubscribe = ipc.onOperationProgress(step => useOperationStore.getState().updateStep(step))
    return () => { mounted = false; unsubscribe() }
  }, [])

  const close = () => { void ipc.closeMergeWindow() }
  const requestClose = async (active: boolean) => {
    if (active && !await useDialogStore.getState().confirm({
      title: 'Close Merge window?',
      message: 'The conflicts will remain unresolved. You can reopen Merge to continue resolving them.',
      detail: 'Closing this window does not abort the merge or discard working files.',
      confirmLabel: 'Close window',
    })) return
    close()
  }

  return (
    <div className="h-screen flex flex-col bg-lg-bg-primary text-lg-text-primary">
      <PanelErrorBoundary tabId="Merge" onGoHome={close}>
        {context ? <MergePreviewDialog targetBranch={context.targetBranch} standalone
          onClose={close} onMerged={() => {}} onRequestClose={requestClose}><StatusBar /></MergePreviewDialog> : (
          <main className="flex-1 p-6 text-sm font-mono" role={error ? 'alert' : 'status'}>
            {error ?? 'Opening Merge…'}
            {error && <button className="block mt-4" onClick={close}>Close window</button>}
          </main>
        )}
      </PanelErrorBoundary>
      <GlobalLoadingCursor />
      <GlobalDialogs />
    </div>
  )
}

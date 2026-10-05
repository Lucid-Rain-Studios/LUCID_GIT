import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorPanel } from '/src/components/errors/ErrorPanel'
import { MergePreviewDialog } from '/src/components/merge/MergePreviewDialog'
import { GlobalDialogs } from '/src/components/ui/GlobalDialogs'
import { useErrorStore } from '/src/stores/errorStore'
import { useRepoStore } from '/src/stores/repoStore'
import { useDialogStore } from '/src/stores/dialogStore'
import '/src/index.css'

const warning = () => useErrorStore.getState().pushRaw('CONFLICT (content): Merge conflict in Content/Asset.uasset', 'test-repo')
window.showWarning = warning
window.showConfirmation = () => useDialogStore.getState().confirm({ title: 'Confirm repair', message: 'Test confirmation', danger: true })
useRepoStore.setState({ repoPath: 'test-repo', currentBranch: 'main' })

function Fixture() {
  const [merge, setMerge] = useState(false)
  window.closeMergeDialog = () => setMerge(false)
  return <>
    <button onClick={() => { warning(); setMerge(true) }}>Open merge with warning</button>
    <button onClick={() => setMerge(true)}>Open merge</button>
    {merge && <MergePreviewDialog targetBranch="feature" onClose={() => setMerge(false)} onMerged={() => {}} />}
    <GlobalDialogs />
    <ErrorPanel onReauth={() => {}} onNavigateTab={() => {}} onOpenMergeResolver={() => {}} />
  </>
}
createRoot(document.getElementById('root')).render(<Fixture />)

import { usePRReviewStore } from '@/stores/prReviewStore'
import { useEffect } from 'react'
import { ipc } from '@/ipc'
import { useMergeWindowStore } from '@/stores/mergeWindowStore'
import { MergeProgressCard } from './MergeProgressCard'

export function LocalMergeProgress() {
  const prReview = usePRReviewStore(s => s.request)
  const task = useMergeWindowStore(s => s.task)
  useEffect(() => ipc.onMergeWindowProgress((progress, context) => {
    useMergeWindowStore.setState({ task: progress ? { ...context, ...progress } : null })
  }), [])

  if (!task || (prReview && task.phase === 'complete')) return null
  return <MergeProgressCard
    label="Local merge progress"
    context={`${task.targetBranch} → ${task.currentBranch}`}
    stage={task.stage}
    error={task.error}
    needsAttention={task.phase === 'attention'}
    autoDismiss={task.phase === 'complete' && task.autoDismiss}
    onDetails={task.phase !== 'complete' ? () => { void ipc.showMergeWindow() } : undefined}
    onDismiss={task.phase === 'complete' ? () => useMergeWindowStore.setState({ task: null }) : undefined}
  />
}

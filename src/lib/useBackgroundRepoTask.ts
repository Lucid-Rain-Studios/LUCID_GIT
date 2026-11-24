import { useState } from 'react'
import { useBackgroundRepoTaskStore } from '@/stores/backgroundRepoTaskStore'
import { useMergeWindowStore } from '@/stores/mergeWindowStore'
import { usePRReviewStore } from '@/stores/prReviewStore'

export function useBackgroundRepoTask(repoPath: string | null) {
  const [hidden, setHidden] = useState(false)
  const [running, setRunning] = useState(false)
  const [stage, setStage] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const activeRepo = useBackgroundRepoTaskStore(s => s.repoPath)
  const localMerge = useMergeWindowStore(s => s.task?.phase)
  const prBusy = usePRReviewStore(s => s.busy)
  const blocked = !!activeRepo || prBusy || (!!localMerge && localMerge !== 'complete')

  const begin = (message: string) => {
    const merge = useMergeWindowStore.getState().task?.phase
    if (!repoPath || useBackgroundRepoTaskStore.getState().repoPath ||
      usePRReviewStore.getState().busy || (merge && merge !== 'complete')) return false
    useBackgroundRepoTaskStore.setState({ repoPath })
    setFailure(null)
    setStage(message)
    setRunning(true)
    setHidden(true)
    return true
  }

  const finish = (error?: string) => {
    if (error) {
      setStage('Needs attention')
      setFailure(error)
    }
    setRunning(false)
    useBackgroundRepoTaskStore.setState({ repoPath: null })
  }

  return { hidden, setHidden, running, stage, setStage, failure, blocked, begin, finish }
}

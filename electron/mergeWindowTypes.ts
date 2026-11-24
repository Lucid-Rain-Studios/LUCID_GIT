export interface MergeWindowContext {
  repoPath: string
  targetBranch: string
  currentBranch: string
}

export interface MergeWindowProgress {
  stage: string
  phase: 'running' | 'attention' | 'complete'
  error?: string
  autoDismiss?: boolean
}

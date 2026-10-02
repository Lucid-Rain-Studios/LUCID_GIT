export interface RecoveryGitTask {
  pid: number
  startedAt: number
  command: string
  ageSeconds: number
  readOnly: boolean
}

export interface RecoveryIndexLock {
  path: string
  ageSeconds: number
  size: number
  token: string
}

export interface IndexRecoveryBlockers {
  repoPath: string
  tasks: RecoveryGitTask[]
  pendingGitCommands: number
  lock: RecoveryIndexLock | null
  lockError?: string
}

export interface IndexLockRecoveryResult {
  backupPath: string | null
  summary: string
  blockers: IndexRecoveryBlockers
}

export interface IndexDiagnosis {
  repoPath: string
  issue: 'healthy' | 'corrupt' | 'checksum' | 'missing' | 'blocked'
  summary: string
  detail: string
  gitVersion: string
  canRepair: boolean
  token: string
  backupId?: string
  backupPath?: string
  canUndo: boolean
  undoReason?: string
}

export interface IndexRepairResult {
  backupId: string
  backupPath: string
  summary: string
  diagnosis: IndexDiagnosis
}

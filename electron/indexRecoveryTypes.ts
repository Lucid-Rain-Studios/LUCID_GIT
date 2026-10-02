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

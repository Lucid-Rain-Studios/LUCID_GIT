export interface PushLockCheck {
  branch: string
  head: string
  remoteUrl: string
  targetBranch: string
  files: string[]
  overrideReason: string | null
}

export interface PushLockOverride {
  branch: string
  head: string
  remoteUrl: string
  targetBranch: string
}

import { create } from 'zustand'
import { parseGitErrorOrGeneric, type LucidGitError } from '@/lib/gitErrors'
import type { IndexDiagnosis, IndexRepairResult, LfsLocksMaintenanceResult } from '@/ipc'

type IssueSource = 'index' | 'lock-cache'
type Issues = Partial<Record<IssueSource, LucidGitError | null>>

export const useRepositoryIssueStore = create<{
  repositories: Record<string, Issues>
  report: (repoPath: string, source: IssueSource, error: LucidGitError | null) => void
}>((set) => ({
  repositories: {},
  report: (repoPath, source, error) => set(state => ({ repositories: {
    ...state.repositories, [repoPath]: { ...state.repositories[repoPath], [source]: error },
  } })),
}))

export function repositoryIssueSource(error: LucidGitError): IssueSource | undefined {
  if (['INDEX_UNREADABLE', 'SHARED_INDEX_UNREADABLE'].includes(error.code)) return 'index'
  if (error.code === 'LFS_LOCK_CACHE') return 'lock-cache'
}

// Observe checks already requested by the user or existing workflows. The
// toolbar never starts an index scan, cache inspection or network request.
export function observeRepositoryDiagnostic(method: string, repoPath: unknown, value: unknown, failure = false): void {
  if (typeof repoPath !== 'string') return
  const report = useRepositoryIssueStore.getState().report
  if (failure) {
    const error = { ...parseGitErrorOrGeneric(String(value)), repoPath }
    const source = repositoryIssueSource(error)
    if (source) report(repoPath, source, error)
    return
  }
  if (method === 'diagnoseIndex' || method === 'repairIndex') {
    const diagnosis = method === 'repairIndex' ? (value as IndexRepairResult)?.diagnosis : value as IndexDiagnosis
    if (!diagnosis || diagnosis.repoPath !== repoPath) return
    if (diagnosis.issue === 'healthy') report(repoPath, 'index', null)
    else if (['corrupt', 'checksum', 'missing'].includes(diagnosis.issue)) {
      report(repoPath, 'index', { ...parseGitErrorOrGeneric('index file corrupt'), repoPath,
        title: diagnosis.summary, gitMessage: diagnosis.detail })
    }
  }
  if (method === 'lfsLocksCheck' || method === 'lfsLocksRepair') {
    const result = value as LfsLocksMaintenanceResult
    if (!result || !Array.isArray(result.lockCacheFiles)) return
    if (!result.hasErrors) report(repoPath, 'lock-cache', null)
    else {
      const files = result.lockCacheFiles.filter(file => file.integrity === 'corrupt')
      const detail = [result.summary, result.verifyError, ...result.lockCacheFiles.filter(file => file.error).map(file => `${file.path}: ${file.error}`)].filter(Boolean).join('\n')
      const parsed = parseGitErrorOrGeneric(files.length ? 'lockcache.db is corrupt' : detail)
      report(repoPath, 'lock-cache', { ...parsed, repoPath, gitMessage: detail,
        ...(!files.length ? { title: 'LFS lock check failed', description: 'The lock check could not verify the current state. Open Locked Files and retry Check Locks for details.', causes: ['Git LFS could not complete the check; see the diagnostic output.'], canAutoFix: false, fixes: [{ label: 'Open Locked Files', action: { type: 'open-settings' as const, section: 'locks' } }] } : {}) })
    }
  }
  if (method === 'clearLockCache') report(repoPath, 'lock-cache', null)
}

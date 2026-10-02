import React, { useRef, useState } from 'react'
import { ipc, type IndexDiagnosis, type IndexRepairResult } from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { useDialogStore } from '@/stores/dialogStore'
import { useOperationStore } from '@/stores/operationStore'
import { ActionBtn } from '@/components/ui/ActionBtn'
import { useErrorStore } from '@/stores/errorStore'
import { Activity, CheckCircle2, AlertTriangle, ShieldCheck, RotateCcw, FolderOpen, LoaderCircle } from 'lucide-react'
import './IndexRecoveryTool.css'

export function IndexRecoveryTool({ repoPath, onRefresh }: { repoPath: string; onRefresh: () => void }) {
  const [diagnosis, setDiagnosis] = useState<IndexDiagnosis | null>(null)
  const [result, setResult] = useState<IndexRepairResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [operation, setOperation] = useState('')
  const request = useRef(0)
  const active = () => useRepoStore.getState().repoPath === repoPath
  const run = async (label: string, fn: () => Promise<void>) => {
    if (busy || !active()) return
    setBusy(true); setError('')
    setOperation(label)
    const id = ++request.current
    try { await useOperationStore.getState().run(label, fn) }
    catch (e) { if (active() && id === request.current) setError(String(e)) }
    finally { if (active() && id === request.current) setBusy(false) }
  }
  const diagnose = () => run('Diagnose Git index', async () => {
    setResult(null)
    const d = await ipc.diagnoseIndex(repoPath)
    if (active()) setDiagnosis(d)
  })
  const repair = () => run('Repair Git index', async () => {
    if (!diagnosis?.canRepair) return
    const confirmed = await useDialogStore.getState().confirm({
      title: 'Repair staging index?', confirmLabel: 'Back up and repair',
      message: diagnosis.detail,
      detail: `Repository: ${repoPath}\nWorking files and branches are preserved. The original index is backed up before replacement. Undo restores the original index and can bring back the original error.`,
    })
    if (!confirmed || !active()) return
    const repaired = await ipc.repairIndex(repoPath, diagnosis.token)
    if (!active()) return
    setResult(repaired)
    setDiagnosis(repaired.diagnosis)
    const shownError = useErrorStore.getState().current
    if (shownError?.repoPath === repoPath && ['INDEX_UNREADABLE', 'SHARED_INDEX_UNREADABLE'].includes(shownError.code)) useErrorStore.getState().dismiss()
    useRepoStore.getState().bumpSyncTick()
    onRefresh()
  })
  const undo = () => run('Undo index repair', async () => {
    if (!diagnosis?.canUndo || !diagnosis.backupId) return
    const confirmed = await useDialogStore.getState().confirm({ title: 'Restore original index?', confirmLabel: 'Undo repair',
      message: 'This restores the saved staging index, including its original error. Working files stay intact. Undo is refused if the branch or staged content changed.', detail: repoPath })
    if (!confirmed || !active()) return
    await ipc.undoIndexRepair(repoPath, diagnosis.backupId)
    if (!active()) return
    setResult(null)
    useRepoStore.getState().bumpSyncTick(); onRefresh()
    const d = await ipc.diagnoseIndex(repoPath)
    if (active()) setDiagnosis(d)
  })
  const healthy = diagnosis?.issue === 'healthy'
  const state = busy ? 'checking' : error ? 'blocked' : diagnosis?.issue === 'blocked' ? 'blocked' : healthy ? 'healthy' : diagnosis ? 'repairable' : 'unchecked'
  const StateIcon = busy ? LoaderCircle : state === 'healthy' ? CheckCircle2 : state === 'blocked' || state === 'repairable' ? AlertTriangle : Activity
  const repoName = repoPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || repoPath
  const backupPath = result?.backupPath || diagnosis?.backupPath
  const repairReason = busy ? 'Wait for the current operation to finish.' : !diagnosis ? 'Run Diagnose to check whether a repair is needed.'
    : healthy ? 'The index is healthy. No repair is needed.' : !diagnosis.canRepair ? 'Resolve the issue shown above, then diagnose again.' : ''
  const undoReason = busy ? 'Wait for the current operation to finish.' : diagnosis?.undoReason || 'Available after a repair, while HEAD and staged content remain unchanged.'
  return (
    <section className="lg-index-recovery" aria-label="Git index recovery" aria-busy={busy}>
      <div className="ir-workspace">
        <header className="ir-header">
          <div><h2 className="ir-title">Git index recovery</h2>
            <p className="ir-lead">Get unstuck when fetch, updates or branch switching fail because of the staging index.</p></div>
          <ActionBtn className="ir-button" disabled={busy} onClick={diagnose} disabledReason="A recovery check is running">Diagnose</ActionBtn>
        </header>
        <div className="ir-repository">
          <FolderOpen size={19} aria-hidden="true" />
          <div><span className="ir-caption">Selected repository</span><strong className="ir-repo-name">{repoName}</strong>
            <code className="ir-path">{repoPath}</code></div>
        </div>
        <div className={`ir-report ir-report--${state}`} role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'} aria-atomic="true">
          <StateIcon className={busy ? 'ir-state-icon ir-spin' : 'ir-state-icon'} size={25} aria-hidden="true" />
          <div className="ir-report-body">
            <span className="ir-status-label">{busy ? 'Check in progress' : error ? 'Operation stopped' : healthy ? 'Healthy index' : state === 'blocked' ? 'Needs attention' : diagnosis ? 'Repair available' : 'Ready to check'}</span>
            <h3 className="ir-report-title">{busy ? `${operation}…` : error ? 'The operation could not finish' : diagnosis?.summary || 'Start with a diagnosis'}</h3>
            <p>{busy ? 'Keep this repository open while the operation finishes.' : error || (state === 'blocked' ? diagnosis?.detail : result?.summary ||
              (healthy ? 'No index repair is needed. You can retry your Git operation.' : diagnosis ? 'Review the repair below. The original index will be saved before any replacement.' : 'We’ll check the index, repository state and safety conditions before enabling a repair.'))}</p>
            {!busy && state !== 'blocked' && diagnosis?.detail && <details className="ir-details">
              <summary>Diagnostic details</summary><pre>{diagnosis.detail}</pre>
            </details>}
            {!busy && diagnosis?.gitVersion && <span className="ir-caption ir-git-version">{diagnosis.gitVersion}</span>}
          </div>
        </div>
        <div className="ir-bottom">
          <div className="ir-actions">
            <div className="ir-action-row">
              <div><h3 className="ir-action-title">Repair the index</h3>
                <p>{diagnosis?.issue === 'checksum' ? 'Correct the checksum while preserving your staged changes.' : 'Build and verify a replacement from the current commit. Working files and branches stay intact; changes become unstaged.'}</p>
                {repairReason && <p className="ir-action-hint">{repairReason}</p>}</div>
              <ActionBtn className="ir-button" disabled={busy || !diagnosis?.canRepair} onClick={repair} disabledReason={repairReason}>Back up and repair</ActionBtn>
            </div>
            <div className="ir-action-row">
              <div><h3 className="ir-action-title"><RotateCcw size={15} aria-hidden="true" /> Undo a repair</h3>
                <p>Restore the saved index. This can bring back the original error.</p>
                {!diagnosis?.canUndo && <p className="ir-action-hint">{undoReason}</p>}</div>
              <ActionBtn className="ir-button" ghost disabled={busy || !diagnosis?.canUndo} onClick={undo} disabledReason={undoReason}>Undo repair</ActionBtn>
            </div>
            {backupPath && <div className="ir-backup">
              <span className="ir-caption">Retained backup</span><code className="ir-path">{backupPath}</code>
              <ActionBtn className="ir-button" ghost disabled={busy} onClick={() => { void ipc.showInFolder(backupPath).catch(e => setError(String(e))) }}>Show backup</ActionBtn>
            </div>}
          </div>
          <aside className="ir-safety" aria-label="Recovery safeguards">
            <ShieldCheck size={22} aria-hidden="true" />
            <h3 className="ir-action-title">Your work stays intact</h3>
            <p>Repairs change Git’s staging metadata. They don’t write working files or move branches.</p>
            <p>The original index is backed up, and the replacement is verified before reporting success.</p>
            <p className="ir-before">Close other Git clients before repairing. Existing locks, active operations and unsafe repository states stop recovery.</p>
          </aside>
        </div>
      </div>
    </section>
  )
}

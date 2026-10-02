import React, { useEffect, useRef, useState } from 'react'
import { ipc, type IndexDiagnosis, type IndexRepairResult, type IndexRecoveryBlockers } from '@/ipc'
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
  const [blockers, setBlockers] = useState<IndexRecoveryBlockers | null>(null)
  const [blockerBusy, setBlockerBusy] = useState(false)
  const [blockerError, setBlockerError] = useState('')
  const [blockerNotice, setBlockerNotice] = useState('')
  const [lockBackup, setLockBackup] = useState<string | null>(null)
  const [externalStopped, setExternalStopped] = useState(false)
  const blockerRequest = useRef(0)
  const blockerRunning = useRef(false)
  useEffect(() => {
    const mainGeneration = request, blockerGeneration = blockerRequest
    ++request.current; ++blockerRequest.current; blockerRunning.current = false
    setDiagnosis(null); setResult(null); setBusy(false); setError('')
    setBlockers(null); setBlockerBusy(false); setBlockerError(''); setBlockerNotice(''); setLockBackup(null); setExternalStopped(false)
    return () => { ++mainGeneration.current; ++blockerGeneration.current }
  }, [repoPath])
  const active = () => useRepoStore.getState().repoPath === repoPath
  // Independent of diagnosis and the global operation store: cancellation
  // must remain usable while another Git action holds the repository gate.
  const blockerRun = async (fn: (valid: () => boolean) => Promise<void>) => {
    if (blockerRunning.current || !active()) return
    blockerRunning.current = true; setBlockerBusy(true); setBlockerError('')
    const id = ++blockerRequest.current
    const valid = () => active() && id === blockerRequest.current
    try { await fn(valid) }
    catch (e) { if (valid()) setBlockerError(String(e)) }
    finally { if (valid()) { blockerRunning.current = false; setBlockerBusy(false) } }
  }
  const refreshBlockers = async (valid: () => boolean) => {
    const checked = await ipc.checkIndexBlockers(repoPath)
    if (valid()) { setBlockers(checked); setExternalStopped(false) }
    return checked
  }
  const checkTasks = () => blockerRun(async valid => {
    setBlockerNotice('')
    await refreshBlockers(valid)
  })
  const stopTasks = (backgroundOnly: boolean) => blockerRun(async valid => {
    const reviewed = blockers?.tasks.filter(task => !backgroundOnly || task.readOnly) ?? []
    if (!reviewed.length) return
    const writes = reviewed.some(task => !task.readOnly)
    const confirmed = await useDialogStore.getState().confirm({
      title: writes ? 'Stop the listed Git tasks?' : 'Stop background Git tasks?', danger: writes,
      confirmLabel: 'Stop listed tasks',
      message: writes ? 'This interrupts Lucid Git commands for this repository, including writes. A checkout, merge or download can be left incomplete and may require recovery.'
        : 'Stop the listed Lucid Git background queries for this repository. You can refresh their results afterward.',
      detail: `Repository: ${repoPath}\n${reviewed.map(task => `${task.command} · PID ${task.pid}`).join('\n')}\nOther repositories and external Git clients are unaffected. Index locks are not removed.`,
    })
    if (!confirmed || !valid()) return
    const count = await ipc.stopIndexTasks(repoPath, reviewed.map(({ pid, startedAt }) => ({ pid, startedAt })), true)
    if (!valid()) return
    if (busy && operation === 'Diagnose Git index') { ++request.current; setBusy(false) }
    setBlockerNotice(`Stopped ${count} listed Lucid Git task${count === 1 ? '' : 's'}. Any index lock was left intact.`)
    const checked = await refreshBlockers(valid)
    if (valid() && checked.pendingGitCommands === 0 && !checked.tasks.length) {
      const d = await ipc.diagnoseIndex(repoPath)
      if (valid()) { setDiagnosis(d); setError(''); useRepoStore.getState().bumpSyncTick(); onRefresh() }
    }
  })
  const recoverLock = () => blockerRun(async valid => {
    if (!blockers?.lock || !externalStopped || blockers.tasks.length || blockers.pendingGitCommands) return
    const confirmed = await useDialogStore.getState().confirm({
      title: 'Back up and remove this index lock?', confirmLabel: 'Back up and remove lock', danger: true,
      message: 'Only continue after all other Git clients and writers have stopped. Removing a live writer’s lock can damage staging or interrupt its work. Lucid Git cannot identify an external lock owner.',
      detail: `Repository: ${repoPath}\nLock: ${blockers.lock.path}\nThe exact reviewed lock will be backed up before removal. The staging index, branches and working files will not be replaced.`,
    })
    if (!confirmed || !valid()) return
    const recovered = await ipc.recoverIndexLock(repoPath, blockers.lock.token, true)
    if (!valid()) return
    if (busy && operation === 'Diagnose Git index') { ++request.current; setBusy(false) }
    setLockBackup(recovered.backupPath); setBlockerNotice(recovered.summary); setBlockers(recovered.blockers); setExternalStopped(false)
    const d = await ipc.diagnoseIndex(repoPath)
    if (!valid()) return
    setDiagnosis(d); setError('')
    const shownError = useErrorStore.getState().current
    if (!recovered.blockers.lock && !recovered.blockers.lockError && shownError?.repoPath === repoPath && shownError.code === 'INDEX_LOCK') useErrorStore.getState().dismiss()
    useRepoStore.getState().bumpSyncTick(); onRefresh()
  })
  const run = async (label: string, fn: (valid: () => boolean) => Promise<void>) => {
    if (busy || !active()) return
    setBusy(true); setError('')
    setOperation(label)
    const id = ++request.current
    const valid = () => active() && id === request.current
    try {
      if (label === 'Diagnose Git index') await fn(valid)
      else await useOperationStore.getState().run(label, () => fn(valid))
    }
    catch (e) { if (active() && id === request.current) setError(String(e)) }
    finally { if (active() && id === request.current) setBusy(false) }
  }
  const diagnose = () => run('Diagnose Git index', async valid => {
    setResult(null)
    const d = await ipc.diagnoseIndex(repoPath)
    if (valid()) setDiagnosis(d)
  })
  const repair = () => run('Repair Git index', async valid => {
    if (!diagnosis?.canRepair) return
    const confirmed = await useDialogStore.getState().confirm({
      title: 'Repair staging index?', confirmLabel: 'Back up and repair',
      message: diagnosis.detail,
      detail: `Repository: ${repoPath}\nWorking files and branches are preserved. The original index is backed up before replacement. Undo restores the original index and can bring back the original error.`,
    })
    if (!confirmed || !valid()) return
    const repaired = await ipc.repairIndex(repoPath, diagnosis.token)
    if (!valid()) return
    setResult(repaired)
    setDiagnosis(repaired.diagnosis)
    const shownError = useErrorStore.getState().current
    if (shownError?.repoPath === repoPath && ['INDEX_UNREADABLE', 'SHARED_INDEX_UNREADABLE'].includes(shownError.code)) useErrorStore.getState().dismiss()
    useRepoStore.getState().bumpSyncTick()
    onRefresh()
  })
  const undo = () => run('Undo index repair', async valid => {
    if (!diagnosis?.canUndo || !diagnosis.backupId) return
    const confirmed = await useDialogStore.getState().confirm({ title: 'Restore original index?', confirmLabel: 'Undo repair',
      message: 'This restores the saved staging index, including its original error. Working files stay intact. Undo is refused if the branch or staged content changed.', detail: repoPath })
    if (!confirmed || !valid()) return
    await ipc.undoIndexRepair(repoPath, diagnosis.backupId)
    if (!valid()) return
    setResult(null)
    useRepoStore.getState().bumpSyncTick(); onRefresh()
    const d = await ipc.diagnoseIndex(repoPath)
    if (valid()) setDiagnosis(d)
  })
  const healthy = diagnosis?.issue === 'healthy'
  const state = busy ? 'checking' : error ? 'blocked' : diagnosis?.issue === 'blocked' ? 'blocked' : healthy ? 'healthy' : diagnosis ? 'repairable' : 'unchecked'
  const StateIcon = busy ? LoaderCircle : state === 'healthy' ? CheckCircle2 : state === 'blocked' || state === 'repairable' ? AlertTriangle : Activity
  const repoName = repoPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || repoPath
  const backupPath = result?.backupPath || diagnosis?.backupPath
  const repairReason = busy ? 'Wait for the current operation to finish.' : !diagnosis ? 'Run Diagnose to check whether a repair is needed.'
    : healthy ? 'The index is healthy. No repair is needed.' : !diagnosis.canRepair ? 'Resolve the issue shown above, then diagnose again.' : ''
  const undoReason = busy ? 'Wait for the current operation to finish.' : diagnosis?.undoReason || 'Available after a repair, while HEAD and staged content remain unchanged.'
  const lockReason = blockerBusy ? 'Wait for the current task or lock check.' : !blockers ? 'Check tasks and lock first.'
    : blockers.lockError ? 'The lock could not be inspected. Resolve the error and check again.' : !blockers.lock ? 'Lock removal is available only when an index lock is present.'
    : blockers.tasks.length || blockers.pendingGitCommands ? 'Stop Lucid Git tasks or wait for them to finish, then check again.'
    : !externalStopped ? 'Confirm that all external Git writers have stopped.' : ''
  return (
    <section className="lg-index-recovery" aria-label="Git index recovery">
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
        <div className={`ir-report ir-report--${state}`} role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'} aria-atomic="true" aria-busy={busy}>
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
        <section className="ir-unblock" aria-label="Git tasks and lock recovery" aria-busy={blockerBusy}>
          <div className="ir-action-row">
            <div><h3 className="ir-action-title">Check Git tasks and the index lock</h3>
              <p>A lock file can remain after a crash. Its presence does not prove a Git process is running.</p></div>
            <ActionBtn className="ir-button" ghost disabled={blockerBusy} disabledReason="A task or lock check is running" onClick={checkTasks}>Check tasks and lock</ActionBtn>
          </div>
          {blockers && <>
            <p>Lucid Git tasks in this repository: {blockers.tasks.length}. Commands still finishing: {Math.max(0, blockers.pendingGitCommands - blockers.tasks.length)}.</p>
            {!!blockers.tasks.length && <ul className="ir-task-list">{blockers.tasks.map(task => <li key={`${task.pid}-${task.startedAt}`}>
              <strong>{task.command}</strong> · PID {task.pid} · {task.ageSeconds}s · {task.readOnly ? 'Background query' : 'May change the repository'}
            </li>)}</ul>}
            <p className="ir-action-hint">These are tasks owned by this running Lucid Git session. Close external Git clients and use Task Manager for processes left by earlier sessions.</p>
            <div className="ir-task-actions">
              <ActionBtn className="ir-button" ghost disabled={blockerBusy || !blockers.tasks.some(task => task.readOnly)} disabledReason="No listed background tasks to stop" onClick={() => stopTasks(true)}>Stop background tasks</ActionBtn>
              <ActionBtn className="ir-button" ghost disabled={blockerBusy || !blockers.tasks.length} disabledReason="No listed Lucid Git tasks to stop" onClick={() => stopTasks(false)}>Stop listed Git tasks</ActionBtn>
            </div>
            {blockers.lockError ? <p role="alert" className="ir-action-hint">{blockers.lockError}</p> : blockers.lock ? <>
              <p className="ir-action-hint">Index lock present · {blockers.lock.size} bytes · {blockers.lock.ageSeconds}s old. Ownership is unknown; age does not prove it is safe to remove.</p>
              <code className="ir-path">{blockers.lock.path}</code>
              <label className="ir-lock-confirm"><input type="checkbox" checked={externalStopped} disabled={blockerBusy}
                onChange={event => setExternalStopped(event.target.checked)} /> I have closed other Git clients and verified that no external Git writer is running.</label>
            </> : <p className="ir-action-hint">No index lock was found at the last check.</p>}
          </>}
          <div className="ir-task-actions">
            <ActionBtn className="ir-button" disabled={!!lockReason} disabledReason={lockReason} onClick={recoverLock}>Back up and remove lock</ActionBtn>
            {lockReason && <p className="ir-action-hint">{lockReason}</p>}
          </div>
          {blockerError && <p className="ir-action-hint" role="alert">{blockerError}</p>}
          {blockerNotice && <p className="ir-action-hint" role="status">{blockerNotice}</p>}
          {lockBackup && <div className="ir-backup"><span className="ir-caption">Retained lock backup</span><code className="ir-path">{lockBackup}</code>
            <ActionBtn className="ir-button" ghost onClick={() => { void ipc.showInFolder(lockBackup).catch(e => setBlockerError(String(e))) }}>Show lock backup</ActionBtn></div>}
        </section>
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
            <p className="ir-before">Close other Git clients before repairing. Automatic repair preserves existing locks. Deliberate lock removal requires your confirmation and a verified backup.</p>
          </aside>
        </div>
      </div>
    </section>
  )
}

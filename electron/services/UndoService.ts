import { BrowserWindow } from 'electron'
import { execSafe } from '../util/dugite-exec'
import { CHANNELS } from '../ipc/channels'

// Operations we capture a checkpoint for so they can be undone with one click.
export type UndoableOp =
  | 'pull' | 'merge' | 'update-from-main' | 'reset' | 'checkout' | 'revert' | 'cherry-pick'

interface Checkpoint {
  op:          UndoableOp
  label:       string       // human label e.g. "Pull", "Update from main"
  headBefore:  string       // HEAD commit hash before the op
  branchBefore: string      // branch name before the op ('' if detached)
  detached:    boolean
  expectedHead: string
  expectedBranch: string
  verificationError?: string
  stashRef?:   string       // dangling `git stash create` snapshot of pre-op WIP, if any
  at:          number
}

export interface UndoInfo { op: UndoableOp; label: string }

// Checkpoint-based undo + auto-snapshot. Before a risky op we record HEAD, the
// current branch, and (if the tree is dirty) a `git stash create` snapshot that
// captures uncommitted work without disturbing the working tree. Undo resets
// HEAD back and re-applies the snapshot, restoring the user's prior state.
class UndoService {
  private checkpoints = new Map<string, Checkpoint>()

  async recordCheckpoint(repoPath: string, op: UndoableOp, label: string): Promise<void> {
    try {
      // Independent read-only queries can run together. On very large working
      // trees this removes two serial process round-trips before pull begins.
      const [head, branchRes, status] = await Promise.all([
        execSafe(['rev-parse', 'HEAD'], repoPath),
        execSafe(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath),
        execSafe(['status', '--porcelain', '--untracked-files=no'], repoPath),
      ])
      if (head.exitCode !== 0 || !head.stdout.trim()) { this.checkpoints.delete(repoPath); return }
      if (branchRes.exitCode !== 0 || status.exitCode !== 0) throw new Error('Could not inspect repository state for Undo. Operation stopped.')

      const branch = branchRes.stdout.trim()
      const detached = branch === 'HEAD' || branch === ''

      // Snapshot uncommitted work as a dangling commit — does not touch the tree
      // or the stash list, so it never interferes with the operation about to run.
      let stashRef: string | undefined
      if (status.exitCode === 0 && status.stdout.trim()) {
        const created = await execSafe(['stash', 'create', `lucid-undo:${label}`], repoPath)
        if (created.exitCode !== 0 || !created.stdout.trim()) throw new Error(`Could not save working changes for Undo. Operation stopped: ${created.stderr.trim()}`)
        stashRef = created.stdout.trim()
      }

      this.checkpoints.set(repoPath, {
        op, label,
        headBefore:   head.stdout.trim(),
        branchBefore: detached ? '' : branch,
        detached,
        expectedHead: head.stdout.trim(),
        expectedBranch: branch,
        stashRef,
        at: Date.now(),
      })
    } catch (error) {
      this.checkpoints.delete(repoPath)
      throw error
    }
  }

  // Call after the op succeeds — notifies the renderer to offer an Undo.
  async markAvailable(repoPath: string): Promise<void> {
    const cp = this.checkpoints.get(repoPath)
    if (!cp) return
    try {
      const [head, branch] = await Promise.all([
        execSafe(['rev-parse', 'HEAD'], repoPath),
        execSafe(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath),
      ])
      if (head.exitCode !== 0 || branch.exitCode !== 0) throw new Error('Could not verify Undo state')
      cp.expectedHead = head.stdout.trim()
      cp.expectedBranch = branch.stdout.trim()
    } catch {
      cp.verificationError = `Could not verify the post-operation state. Undo is unavailable.${cp.stashRef ? ` Snapshot ${cp.stashRef} is retained for recovery.` : ''}`
      return
    }
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send(CHANNELS.EVT_UNDO_AVAILABLE, { repoPath, label: cp.label } as UndoInfo & { repoPath: string })
      }
    })
  }

  discard(repoPath: string): void {
    this.checkpoints.delete(repoPath)
  }

  peek(repoPath: string): UndoInfo | null {
    const cp = this.checkpoints.get(repoPath)
    return cp ? { op: cp.op, label: cp.label } : null
  }

  async undo(repoPath: string): Promise<{ ok: boolean; label: string; message: string }> {
    const cp = this.checkpoints.get(repoPath)
    if (!cp) return { ok: false, label: '', message: 'Nothing to undo.' }
    if (cp.verificationError) return { ok: false, label: cp.label, message: cp.verificationError }

    try {
      const [head, branch] = await Promise.all([
        execSafe(['rev-parse', 'HEAD'], repoPath),
        execSafe(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath),
      ])
      if (head.exitCode !== 0 || branch.exitCode !== 0 || head.stdout.trim() !== cp.expectedHead || branch.stdout.trim() !== cp.expectedBranch) {
        return { ok: false, label: cp.label, message: 'The branch or HEAD changed since this checkpoint. Return to the checkpoint state before undoing.' }
      }
      if (cp.op === 'checkout') {
        const target = cp.detached ? cp.headBefore : cp.branchBefore
        const res = await execSafe(['checkout', target], repoPath)
        if (res.exitCode !== 0) return { ok: false, label: cp.label, message: res.stderr.trim() || 'Undo failed.' }
      } else {
        if (branch.exitCode !== 0 || branch.stdout.trim() !== (cp.detached ? 'HEAD' : cp.branchBefore)) {
          return { ok: false, label: cp.label, message: 'The active branch changed since this checkpoint. Return to the original branch before undoing.' }
        }
        const reset = await execSafe(['reset', '--hard', cp.headBefore], repoPath)
        if (reset.exitCode !== 0) return { ok: false, label: cp.label, message: reset.stderr.trim() || 'Undo failed.' }
        cp.expectedHead = cp.headBefore
        // Restore both the working tree and index; retain the snapshot on failure.
        if (cp.stashRef) {
          const restored = await execSafe(['stash', 'apply', '--index', cp.stashRef], repoPath)
          if (restored.exitCode !== 0) return {
            ok: false, label: cp.label,
            message: `Could not restore the saved staging state. Snapshot ${cp.stashRef} is retained for recovery: ${restored.stderr.trim() || restored.stdout.trim()}`,
          }
        }
      }
      this.checkpoints.delete(repoPath)
      return { ok: true, label: cp.label, message: `Undid ${cp.label.toLowerCase()}.` }
    } catch (e) {
      return { ok: false, label: cp.label, message: String(e) }
    }
  }
}

export const undoService = new UndoService()

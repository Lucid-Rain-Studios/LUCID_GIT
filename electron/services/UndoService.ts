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
      const head = await execSafe(['rev-parse', 'HEAD'], repoPath)
      if (head.exitCode !== 0 || !head.stdout.trim()) { this.checkpoints.delete(repoPath); return }

      const branchRes = await execSafe(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
      const branch = branchRes.stdout.trim()
      const detached = branch === 'HEAD' || branch === ''

      // Snapshot uncommitted work as a dangling commit — does not touch the tree
      // or the stash list, so it never interferes with the operation about to run.
      let stashRef: string | undefined
      const status = await execSafe(['status', '--porcelain'], repoPath)
      if (status.exitCode === 0 && status.stdout.trim()) {
        const created = await execSafe(['stash', 'create', `lucid-undo:${label}`], repoPath)
        if (created.exitCode === 0 && created.stdout.trim()) stashRef = created.stdout.trim()
      }

      this.checkpoints.set(repoPath, {
        op, label,
        headBefore:   head.stdout.trim(),
        branchBefore: detached ? '' : branch,
        detached,
        stashRef,
        at: Date.now(),
      })
    } catch {
      this.checkpoints.delete(repoPath)
    }
  }

  // Call after the op succeeds — notifies the renderer to offer an Undo.
  markAvailable(repoPath: string): void {
    const cp = this.checkpoints.get(repoPath)
    if (!cp) return
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

    try {
      if (cp.op === 'checkout') {
        const target = cp.detached ? cp.headBefore : cp.branchBefore
        const res = await execSafe(['checkout', target], repoPath)
        if (res.exitCode !== 0) return { ok: false, label: cp.label, message: res.stderr.trim() || 'Undo failed.' }
      } else {
        const reset = await execSafe(['reset', '--hard', cp.headBefore], repoPath)
        if (reset.exitCode !== 0) return { ok: false, label: cp.label, message: reset.stderr.trim() || 'Undo failed.' }
        // Restore the pre-op working changes captured in the snapshot (best-effort).
        if (cp.stashRef) {
          await execSafe(['stash', 'apply', cp.stashRef], repoPath)
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

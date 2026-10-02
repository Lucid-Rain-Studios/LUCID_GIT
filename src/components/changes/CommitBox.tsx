import React, { useEffect, useRef, useState } from 'react'
import { useRepoStore } from '@/stores/repoStore'
import { useOperationStore } from '@/stores/operationStore'
import { ipc } from '@/ipc'
import { cn } from '@/lib/utils'
import { useErrorStore } from '@/stores/errorStore'
import { useDialogStore } from '@/stores/dialogStore'
import { markFetchPerformed } from '@/lib/fetchState'
import { ActionBtn } from '@/components/ui/ActionBtn'
import { AppCheckbox } from '@/components/ui/AppCheckbox'

const drafts = new Map<string, { title: string; message: string }>()

interface CommitBoxProps {
  deferredStagePaths?: string[]
}

export function CommitBox({ deferredStagePaths }: CommitBoxProps = {}) {
  const { repoPath, fileStatus, refreshStatus, bumpSyncTick } = useRepoStore()
  const opRun = useOperationStore(s => s.run)
  const dialog = useDialogStore()

  const [title, setTitle]               = useState(() => repoPath ? drafts.get(repoPath)?.title ?? '' : '')
  const [message, setMessage]           = useState(() => repoPath ? drafts.get(repoPath)?.message ?? '' : '')
  const [isCommitting, setIsCommitting] = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [commitFailed, setCommitFailed] = useState(false)

  const [amend, setAmend]               = useState(false)
  const [lastMessage, setLastMessage]   = useState<string | null>(null)
  const [headPushed, setHeadPushed]     = useState(false)
  const [originalTitle, setOriginalTitle]     = useState(title)
  const [originalMessage, setOriginalMessage] = useState(message)

  const pushError = useErrorStore(s => s.pushRaw)
  const workflowBusy = useRef(false)
  const draftRepo = useRef(repoPath)
  const draft = useRef({ title: '', message: '' })
  // Save only the original draft while amend temporarily displays HEAD's message.
  draft.current = amend ? { title: originalTitle, message: originalMessage } : { title, message }
  useEffect(() => {
    if (draftRepo.current !== repoPath) {
      const next = repoPath ? drafts.get(repoPath) : null
      setTitle(next?.title ?? '')
      setMessage(next?.message ?? '')
      setOriginalTitle(next?.title ?? '')
      setOriginalMessage(next?.message ?? '')
      setAmend(false)
      setError(null)
      setCommitFailed(false)
      draftRepo.current = repoPath
    }
    return () => {
      if (repoPath) drafts.set(repoPath, draft.current)
    }
  }, [repoPath])

  // Load HEAD info so the amend toggle can pre-fill the message and warn
  // when the commit is already pushed.
  useEffect(() => {
    if (!repoPath) { setLastMessage(null); setHeadPushed(false); return }
    let cancelled = false
    Promise.all([
      ipc.lastCommitMessage(repoPath).catch(() => null),
      ipc.isHeadPushed(repoPath).catch(() => false),
    ]).then(([msg, pushed]) => {
      if (cancelled) return
      setLastMessage(msg)
      setHeadPushed(pushed)
      // Amending a pushed commit would rewrite already-shared history, so the
      // option is only available for local commits — clear any stale toggle.
      if (pushed) setAmend(false)
    })
    return () => { cancelled = true }
  }, [repoPath, fileStatus.length])

  // When the user toggles amend, swap the title/body content but preserve
  // what they had typed before, so toggling back restores it.
  useEffect(() => {
    if (amend) {
      setOriginalTitle(title)
      setOriginalMessage(message)
      if (lastMessage !== null) {
        const [firstLine, ...rest] = lastMessage.split('\n')
        setTitle(firstLine ?? '')
        // The classic git convention is one blank line between subject and
        // body; trim that leading blank so the body textarea isn't padded.
        const body = rest.join('\n').replace(/^\n+/, '')
        setMessage(body)
      }
    } else {
      setTitle(originalTitle)
      setMessage(originalMessage)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amend])

  const selectedCount = deferredStagePaths
    ? deferredStagePaths.length
    : fileStatus.filter(f => f.staged).length

  // Amend without new file changes is valid (it can edit just the message),
  // so don't require staged files when amending. The title is the only
  // required field — body/description is optional.
  const canCommit = Boolean(
    repoPath && title.trim() && !isCommitting && (amend || selectedCount > 0),
  )

  // Build the final commit message from title + optional body, using the
  // standard "subject line · blank · body" git convention.
  const buildCommitMessage = (): string => {
    const t = title.trim()
    const b = message.trim()
    return b ? `${t}\n\n${b}` : t
  }

  const prepareDeferredStage = async () => {
    if (!repoPath || !deferredStagePaths) return
    const selected = new Set(deferredStagePaths)
    const stagedPaths = fileStatus.filter(f => f.staged).map(f => f.path)
    const unselectedStaged = stagedPaths.filter(path => !selected.has(path))

    if (unselectedStaged.length > 0) await ipc.unstage(repoPath, unselectedStaged)
    if (deferredStagePaths.length > 0) await ipc.stage(repoPath, deferredStagePaths)
  }

  const runCommit = async (noVerify = false) => {
    if (!repoPath) return
    setIsCommitting(true)
    setError(null)
    setCommitFailed(false)

    try {
      const finalMessage = buildCommitMessage()
      if (amend) {
        await opRun('Amending commit…', () => ipc.commitAmend(repoPath, finalMessage, noVerify))
      } else {
        await opRun('Committing…', () => ipc.commit(repoPath, finalMessage, noVerify))
      }
      drafts.delete(repoPath)
      if (useRepoStore.getState().repoPath !== repoPath) return
      setTitle('')
      setMessage('')
      setOriginalTitle('')
      setOriginalMessage('')
      setAmend(false)
      await refreshStatus()

      // Keep upstream sync counts accurate for Pull/Push badges
      await ipc.fetch(repoPath).then(() => markFetchPerformed(repoPath)).catch(() => {})
      bumpSyncTick()

    } catch (e) {
      const s = String(e)
      if (useRepoStore.getState().repoPath === repoPath) {
        setError(s)
        setCommitFailed(true)
      }
      pushError(s, repoPath)
      // The failure may stem from files that changed on disk since the last
      // refresh — reconcile the list so stale rows don't linger.
      refreshStatus()
    } finally {
      setIsCommitting(false)
    }
  }

  const handleCommit = async () => {
    if (!canCommit || !repoPath || workflowBusy.current) return
    workflowBusy.current = true
    setIsCommitting(true)

    // Native Git owns hook ordering and validation.
    setError(null)

    try {
      await prepareDeferredStage()
      // Git runs its complete native hook sequence once, including commit-msg.
      await runCommit(false)
    } catch (e) {
      setError(String(e))
      refreshStatus()
    } finally {
      workflowBusy.current = false
      setIsCommitting(false)
    }
  }

  const handleBypass = async () => {
    if (!canCommit || !repoPath || !commitFailed || workflowBusy.current) return
    workflowBusy.current = true
    setIsCommitting(true)
    try {
      const confirmed = await dialog.confirm({
        title: 'Bypass commit hooks',
        message: 'Retry the failed commit while skipping pre-commit and commit-msg checks?',
        detail: 'This bypasses repository commit policy. Review the failure before continuing.',
        confirmLabel: 'Bypass & Commit', danger: true,
      })
      if (!confirmed || useRepoStore.getState().repoPath !== repoPath) return
      await prepareDeferredStage()
      await runCommit(true)
    } catch (e) {
      setError(String(e))
    } finally {
      workflowBusy.current = false
      setIsCommitting(false)
    }
  }

  const commitLabel = (() => {
    if (isCommitting)            return amend ? 'Amending…' : 'Committing…'
    if (amend) {
      return selectedCount > 0
        ? `Amend (+${selectedCount} file${selectedCount !== 1 ? 's' : ''})`
        : 'Amend message'
    }
    return selectedCount > 0
      ? `Commit ${selectedCount} file${selectedCount !== 1 ? 's' : ''}`
      : 'Commit'
  })()

  return (
    <div className="border-t border-lg-border p-2.5 space-y-2 shrink-0 bg-lg-bg-secondary">
      {/* Amend toggle */}
      {lastMessage !== null && (
        <label
          className={cn(
            'flex items-center gap-2 select-none min-w-0',
            headPushed ? 'cursor-not-allowed' : 'cursor-pointer',
          )}
          title={
            headPushed
              ? 'The last commit is already pushed — amending it would rewrite shared history. Make a new commit instead.'
              : lastMessage
          }
        >
          <AppCheckbox
            checked={amend}
            onChange={() => setAmend(a => !a)}
            disabled={headPushed}
            color="#4a9eff"
          />
          <span className={cn(
            'flex items-baseline gap-1 min-w-0 flex-1 text-[10px] font-mono leading-none',
            headPushed && 'opacity-50',
          )}>
            <span className="text-lg-text-secondary whitespace-nowrap">Amend previous commit</span>
            <span className="text-lg-text-secondary/60 whitespace-nowrap">—</span>
            <span className="text-lg-text-secondary/70 truncate min-w-0">
              {lastMessage.split('\n')[0]}
            </span>
          </span>
          {headPushed && (
            <span
              className="text-[9px] font-mono text-lg-text-secondary/70 font-semibold shrink-0"
              title="The last commit is already on the remote."
            >
              PUSHED
            </span>
          )}
        </label>
      )}

      <input
        type="text"
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canCommit) handleCommit()
        }}
        placeholder={
          amend
            ? 'Amend title'
            : selectedCount > 0
              ? 'Title (required)'
              : 'Stage changes to commit'
        }
        disabled={(selectedCount === 0 && !amend) || isCommitting}
        className="w-full bg-lg-bg-primary border border-lg-border rounded px-2 py-1.5 text-xs font-mono text-lg-text-primary placeholder:text-lg-text-secondary focus:outline-none focus:border-lg-accent disabled:opacity-40 transition-colors"
      />

      <textarea
        value={message}
        onChange={e => setMessage(e.target.value)}
        onKeyDown={e => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canCommit) handleCommit()
        }}
        placeholder={
          amend
            ? 'Description (optional)'
            : selectedCount > 0
              ? 'Description (optional, Ctrl+Enter to commit)'
              : ''
        }
        disabled={(selectedCount === 0 && !amend) || isCommitting}
        rows={3}
        className="w-full bg-lg-bg-primary border border-lg-border rounded px-2 py-1.5 text-xs font-mono text-lg-text-primary placeholder:text-lg-text-secondary resize-none focus:outline-none focus:border-lg-accent disabled:opacity-40 transition-colors"
      />

      {error && (
        <div
          className="text-[10px] font-mono text-lg-error truncate"
          title={error}
        >
          {error}
        </div>
      )}

      {commitFailed && (
        <ActionBtn onClick={handleBypass} disabled={isCommitting} color="#f5a832" size="sm">
          Bypass hooks & retry (confirm required)
        </ActionBtn>
      )}
      <ActionBtn
        onClick={handleCommit}
        disabled={!canCommit}
        color={amend ? '#f5a832' : '#2dbd6e'}
        size="sm"
        style={{ width: '100%', height: 28, fontSize: 11, fontFamily: 'var(--lg-font-mono)', fontWeight: 600 }}
      >
        {commitLabel}
      </ActionBtn>
    </div>
  )
}

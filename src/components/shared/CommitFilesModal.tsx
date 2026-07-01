import React, { useEffect, useState } from 'react'
import { ipc, CommitEntry, CommitFileChange } from '@/ipc'
import { CommitDetail } from '@/components/history/HistoryPanel'
import { useDialogOverlayDismiss } from '@/lib/useDialogOverlayDismiss'

// Modal showing everything a single commit changed. Reuses the same
// header + file list used by the History panel's commit detail pane, just
// wrapped in a dialog for places that don't have room for a permanent pane
// (e.g. the Content Browser's file history list).
export function CommitFilesModal({ repoPath, commit, remoteUrl, onClose }: {
  repoPath: string
  commit: CommitEntry
  remoteUrl: string | null
  onClose: () => void
}) {
  const [files, setFiles] = useState<CommitFileChange[]>([])
  const [filesLoading, setFilesLoading] = useState(true)

  useEffect(() => {
    setFilesLoading(true)
    ipc.commitFiles(repoPath, commit.hash)
      .then(setFiles)
      .catch(() => setFiles([]))
      .finally(() => setFilesLoading(false))
  }, [repoPath, commit.hash])

  const overlayDismiss = useDialogOverlayDismiss(onClose)

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      {...overlayDismiss}
    >
      <div style={{
        width: 'min(720px, 92vw)', height: 'min(620px, 88vh)',
        background: '#161a27', border: '1px solid #2f3a54',
        borderRadius: 10, boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        position: 'relative',
      }}>
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute', top: 10, right: 10, zIndex: 1,
            background: 'none', border: 'none', color: '#4e5870', fontSize: 20,
            cursor: 'pointer', padding: '0 4px', lineHeight: 1,
          }}
          onMouseEnter={e => (e.currentTarget.style.color = '#dde1f0')}
          onMouseLeave={e => (e.currentTarget.style.color = '#4e5870')}
        >×</button>
        <CommitDetail commit={commit} files={files} filesLoading={filesLoading} repoPath={repoPath} remoteUrl={remoteUrl} />
      </div>
    </div>
  )
}

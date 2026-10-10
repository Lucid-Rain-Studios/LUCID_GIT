import React from 'react'
import { createPortal } from 'react-dom'
import { BlueprintAssetPanel } from '@/components/shared/FileDetailsSidePanel'
import { useDialogOverlayDismiss } from '@/lib/useDialogOverlayDismiss'

export function BlueprintAssetDialog({ repoPath, filePath, revision, onClose }: { repoPath: string; filePath: string; revision: string; onClose(): void }) {
  const overlay = useDialogOverlayDismiss(onClose, true, 'Read-only Blueprint graph')
  return createPortal(<div {...overlay} className="bp-expanded" style={{ flexDirection: 'column' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--lg-border)', fontFamily: 'var(--lg-font-ui)', color: 'var(--lg-text-primary)' }}>
        <strong style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={filePath}>{filePath.replace(/\\/g, '/').split('/').pop()}</strong>
        <button className="lg-toolbar-control" onClick={onClose}>Close graph</button>
      </header>
      <BlueprintAssetPanel key={[repoPath, filePath, revision].join('|')} single repoPath={repoPath} filePath={filePath} hash={revision} remoteUrl={null} request={{ filePath, leftRef: 'ABSENT', rightRef: revision }} />
  </div>, document.body)
}

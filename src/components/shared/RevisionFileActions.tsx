import React from 'react'
import { ipc } from '@/ipc'
import { BlueprintFileAction } from './BlueprintFileAction'
import { AppRightSelectionItem as Item, AppRightSelectionSeparator as Separator } from '@/components/ui/AppRightSelectionOptions'

/** Read-only file actions shared by Timeline and PR review. Revision actions
 * retain the selected commit; reveal/editor/default-open use the working copy. */
export function RevisionFileActions({ repoPath, filePath, revision, remoteUrl, onClose, onDetails, onBlame }: {
  repoPath: string
  filePath: string
  revision: string
  remoteUrl: string | null
  onClose(): void
  onDetails?(): void
  onBlame?(): void
}) {
  const absolutePath = repoPath.replace(/\\/g, '/').replace(/\/$/, '') + '/' + filePath
  const slug = remoteUrl?.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1]
  const run = (action: () => void) => () => { onClose(); action() }
  return <>
    <BlueprintFileAction repoPath={repoPath} filePath={filePath} revision={revision} onClose={onClose} />
    {onDetails && <Item label="File details" onClick={run(onDetails)} />}
    {onBlame && <Item label="Blame" onClick={run(onBlame)} />}
    <Separator />
    <Item label="Show in Explorer" title="Reveal the current working copy" onClick={run(() => { void ipc.showInFolder(absolutePath) })} />
    <Item label="Open in Visual Studio Code" title="Open the current working copy" onClick={run(() => { void ipc.openExternal('vscode://file/' + absolutePath) })} />
    <Item label="Open with default program" title="Open the current working copy" onClick={run(() => { void ipc.openPath(absolutePath) })} />
    <Separator />
    <Item label="Copy file path" onClick={run(() => { void navigator.clipboard.writeText(absolutePath) })} />
    <Item label="Copy relative file path" onClick={run(() => { void navigator.clipboard.writeText(filePath) })} />
    <Separator />
    <Item label="View on GitHub" disabled={!slug} title={slug ? undefined : 'No GitHub remote detected'}
      onClick={slug ? run(() => { void ipc.openExternal(`https://github.com/${slug}/blob/${revision}/${filePath.split('/').map(encodeURIComponent).join('/')}`) }) : undefined} />
  </>
}

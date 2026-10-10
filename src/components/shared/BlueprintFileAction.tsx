import React from 'react'
import { useAssetViewerStore } from '@/stores/assetViewerStore'
import { AppRightSelectionItem } from '@/components/ui/AppRightSelectionOptions'

export function BlueprintFileAction({ repoPath, filePath, revision = 'WORKING', onClose }: { repoPath: string; filePath: string; revision?: string; onClose(): void }) {
  const open = useAssetViewerStore(state => state.openBlueprint)
  if (!/\.uasset$/i.test(filePath)) return null
  return <AppRightSelectionItem label="Open Blueprint graph" title="Read-only graph view. Asset support is checked when opened." onClick={() => { onClose(); open(repoPath, filePath, revision) }} />
}


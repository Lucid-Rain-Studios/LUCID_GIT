import React from 'react'
import { useAssetViewerStore } from '@/stores/assetViewerStore'
import { AppRightSelectionItem } from '@/components/ui/AppRightSelectionOptions'

export function BlueprintFileAction({ repoPath, filePath, revision = 'WORKING', onClose }: { repoPath: string; filePath: string; revision?: string; onClose(): void }) {
  const open = useAssetViewerStore(state => state.openBlueprint)
  if (!/\.(uasset|umap)$/i.test(filePath)) return null
  return <AppRightSelectionItem label="Open Unreal asset details" title="Read-only contents, changes and previews for the selected revision." onClick={() => { onClose(); open(repoPath, filePath, revision) }} />
}


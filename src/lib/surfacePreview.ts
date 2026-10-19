export function surfacePreviewKind(assetClass = '') {
  if (assetClass === '/Script/Engine.Texture2D') return 'texture'
  if (['/Script/Engine.Material', '/Script/Engine.MaterialInstanceConstant'].includes(assetClass)) return 'material'
  return undefined
}


import type { UnrealAssetObject } from '../../../electron/blueprintTypes'
import { surfacePreviewKind } from '../../lib/surfacePreview'
import { displayValue } from '../../lib/unrealAssetReview'

export function SurfacePreview({ kind, objects }: { kind: 'texture' | 'material'; objects: UnrealAssetObject[] }) {
  const roots = objects.filter(object => surfacePreviewKind(object.classPath) === kind)
  return <section aria-label={kind === 'texture' ? 'Texture preview' : 'Material preview'}>
    <p className="uar-caption">{kind === 'texture'
      ? 'Render texture to inspect the captured Texture2D source image with its original aspect ratio and alpha. Requires the matching installed Unreal Engine. HDR precision, runtime compression and mipmaps are not reproduced.'
      : 'Render material to inspect the captured material or instance on its engine preview mesh. Enable GPU baking for complex shader inputs. The glTF preview may simplify Unreal shading, transparency and procedural effects.'}</p>
    {roots.map(object => <details key={object.path} open><summary>{object.name} · saved {kind} settings</summary>
      {Object.entries(object.properties).filter(([name]) => kind === 'texture' ? /size|source|srgb|compression|filter|address|lod|mip|virtual/i.test(name) : /parent|parameter|blend|shading|twosided|opacity|domain/i.test(name)).map(([name, value]) => <div className="uar-property" key={name}><small>{name}</small><pre>{displayValue(value)}</pre></div>)}
      <p className="uar-caption">Contents lists all captured fields. Inherited defaults and opaque values remain unresolved.</p>
    </details>)}
  </section>
}

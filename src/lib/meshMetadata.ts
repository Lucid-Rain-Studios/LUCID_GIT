import type { UnrealAssetObject } from '../../electron/blueprintTypes'

/** Summaries are saved fields, never derived render/LOD/skeleton claims. */
export function meshMetadata(objects: UnrealAssetObject[]) {
  const names = /^(BoneName|SkeletalBodySetups|ConstraintSetup|PreviewSkeletalMesh|StaticMaterials|Materials|SkeletalMaterials|MaterialSlots|LOD.*|MinLOD|BuildSettings|SourceModels|NaniteSettings|BodySetup|PhysicsAsset|Skeleton|RefSkeleton|Sockets|MorphTargets|Bounds|ExtendedBounds|PositiveBoundsExtension|NegativeBoundsExtension|AggGeom|DefaultInstance|Collision.*|bAllowCPUAccess|LightMap.*|bGenerateMeshDistanceField|AssetImportData|Import.*|bImport.*)$/
  return objects.flatMap(object => {
    const fields = Object.entries(object.properties).filter(([name]) => names.test(name))
    return fields.length || /\.(StaticMesh|SkeletalMesh|PhysicsAsset)$/.test(object.classPath) ? [{ object, fields }] : []
  })
}

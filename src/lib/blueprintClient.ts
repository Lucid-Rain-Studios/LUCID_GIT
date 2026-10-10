import type { BlueprintComparison, BlueprintDocument, BlueprintRequest, BlueprintSide } from '../../electron/blueprintTypes'

// Content/config/version-addressed documents are immutable for a review.
// Capture advertised entries per request so concurrent eviction cannot break it.
export function createBlueprintClient(read: (repo: string, request: BlueprintRequest) => Promise<BlueprintComparison>) {
  const documents = new Map<string, BlueprintDocument>()
  return async (repo: string, request: BlueprintRequest): Promise<BlueprintComparison> => {
    const available = request.force ? new Map<string, BlueprintDocument>() : new Map(documents)
    const result = await read(repo, { ...request, knownDocuments: Array.from(available.keys()) })
    const hydrate = (side: BlueprintSide): BlueprintSide => {
      if (side.status !== 'ready' || !side.documentKey) return side
      const document = side.document ?? available.get(side.documentKey)
      if (!document) throw new Error('Cached Blueprint data is unavailable. Retry reading.')
      available.set(side.documentKey, document)
      documents.delete(side.documentKey)
      documents.set(side.documentKey, document)
      while (documents.size > 8) documents.delete(documents.keys().next().value!)
      return { ...side, document }
    }
    return { left: hydrate(result.left), right: hydrate(result.right) }
  }
}

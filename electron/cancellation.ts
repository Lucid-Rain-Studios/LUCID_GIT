/**
 * Review work abandoned because a newer request replaced it, or its window went
 * away. Nothing failed, so it must not read as an error in the log.
 *
 * Only the message survives an IPC round trip, which is why this matches text
 * and lives in a file with no imports: both the main process and the renderer
 * use it.
 */
const CANCELLED = /\b(?:Blueprint|Scene) review cancelled\.?\s*$/

export function isCancellation(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message
  return CANCELLED.test(typeof message === 'string' ? message : String(error))
}

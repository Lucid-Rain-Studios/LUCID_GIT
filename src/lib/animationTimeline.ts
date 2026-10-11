import { blendSpaceClass } from './blendSpaceReview'
import type { UnrealAssetObject } from '../../electron/blueprintTypes'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const number = (value: unknown) => typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN
const enumValue = (value: unknown) => typeof value === 'string' ? value : record(value).EnumValue
export const animationSequenceClass = (object: UnrealAssetObject) => /^\/Script\/Engine\.(AnimSequence|AnimMontage)$/.test(object.classPath)
export interface AnimationTimingEntry { object: UnrealAssetObject; key: string; label: string; kind: 'Segment' | 'Section' | 'Notify'; start?: number; end?: number; fields: Record<string, unknown>; reason?: string }

/** Saved authored timing only; never evaluate poses, defaults, links or notify execution. */
export function animationTimeline(objects: UnrealAssetObject[]) {
  const roots = objects.filter(animationSequenceClass)
  const entries: AnimationTimingEntry[] = []
  let omitted = 0
  if (roots.length !== 1) return { object: undefined, entries, omitted, length: undefined }
  const object = roots[0], properties = object.properties
  const lengthValue = number(properties.SequenceLength)
  const length = !object.opaqueProperties?.includes('SequenceLength') && Number.isFinite(lengthValue) && lengthValue >= 0 ? lengthValue : undefined
  const append = (entry: AnimationTimingEntry) => { if (entries.length < 1000) entries.push(entry); else omitted++ }
  const anchor = (fields: Record<string, unknown>) => {
    const time = number(fields.LinkValue)
    return enumValue(fields.LinkMethod) === 'EAnimLinkMethod::Absolute' && enumValue(fields.CachedLinkMethod) === 'EAnimLinkMethod::Absolute' && Number.isFinite(time) && time >= 0 ? time : undefined
  }
  const sections = !object.opaqueProperties?.includes('CompositeSections') && properties.CompositeSections
  if (Array.isArray(sections)) { omitted += Math.max(0, sections.length - 1000); sections.slice(0,1000).forEach((value, index) => {
    const fields = record(value), start = anchor(fields)
    append({ object, key: `CompositeSections[${index}]`, label: typeof fields.SectionName === 'string' ? fields.SectionName : `Section ${index + 1}`, kind: 'Section', start, fields, reason: start === undefined ? 'Absolute saved anchor unavailable; linked/relative timing is unresolved.' : undefined })
  })
  }
  const slots = !object.opaqueProperties?.includes('SlotAnimTracks') && properties.SlotAnimTracks
  if (Array.isArray(slots)) slots.forEach((slot, slotIndex) => {
    const track = record(slot), segments = record(track.AnimTrack).AnimSegments
    if (!Array.isArray(segments)) return
    const budget = Math.max(0,1000-entries.length)
    omitted += Math.max(0,segments.length-budget)
    segments.slice(0,budget).forEach((value, index) => {
      const fields = record(value), start = number(fields.StartPos), from = number(fields.AnimStartTime), to = number(fields.AnimEndTime), rate = number(fields.AnimPlayRate), loops = number(fields.LoopingCount)
      const duration = (to - from) * loops / Math.abs(rate), end = start + duration
      const valid = [start, from, to, rate, duration, end].every(Number.isFinite) && start >= 0 && from >= 0 && to >= from && rate !== 0 && Number.isInteger(loops) && loops >= 1
      append({ object, key: `SlotAnimTracks[${slotIndex}].AnimTrack.AnimSegments[${index}]`, label: `${typeof track.SlotName === 'string' ? track.SlotName : 'Unknown slot'} · segment ${index + 1}`, kind: 'Segment', start: valid ? start : undefined, end: valid ? end : undefined, fields, reason: valid ? undefined : 'Incomplete or invalid saved start/trim/play-rate/loop count.' })
    })
  })
  const notifies = !object.opaqueProperties?.includes('Notifies') && properties.Notifies
  if (Array.isArray(notifies)) { const budget=Math.max(0,1000-entries.length); omitted+=Math.max(0,notifies.length-budget); notifies.slice(0,budget).forEach((value, index) => {
    const fields = record(value), start = anchor(fields), duration = number(fields.Duration), end = start === undefined ? NaN : start + duration
    append({ object, key: `Notifies[${index}]`, label: typeof fields.NotifyName === 'string' ? fields.NotifyName : `Notify ${index + 1}`, kind: 'Notify', start, end: Number.isFinite(duration) && duration >= 0 && Number.isFinite(end) ? end : undefined, fields, reason: start === undefined ? 'Absolute saved anchor unavailable; actual trigger timing is unresolved.' : undefined })
  })
  }
  return { object, entries, omitted, length }
}

export function animationMetadata(objects: UnrealAssetObject[]) {
  const names = /^(SequenceLength|RateScale|Skeleton|Notifies|AnimNotifyTracks|CompositeSections|SlotAnimTracks|BlendIn|BlendOut|BlendOutTriggerTime|SyncGroup|SyncSlotIndex|bEnableRootMotion|RootMotionRootLock|bForceRootLock|bUseNormalizedRootMotionScale|ImportFileFramerate|ImportResampleFramerate|TargetFrameRate|CommonTargetFrameRate|BoneCompressionSettings|CurveCompressionSettings|VariableFrameStrippingSettings|DataModel|DataModelInterface|SampleData|BlendParameters(?:\[\d+\])?|InterpolationParam(?:\[\d+\])?|TargetWeightInterpolationSpeedPerSec|bUseGrid|bLoop|AxisToScaleAnimation|PreviewSkeletalMesh)$/
  return objects.filter(object => animationSequenceClass(object) || blendSpaceClass(object.classPath)).map(object => ({ object, fields: Object.entries(object.properties).filter(([name]) => names.test(name)) }))
}

import React, { useEffect, useState } from 'react'
import { ipc, FileStatus, AssetDiffResult, AssetDelta } from '@/ipc'

interface AssetDiffViewerProps {
  file: FileStatus
  repoPath: string
  staged: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b === 0)            return '0 B'
  const abs = Math.abs(b)
  if (abs < 1_024)        return `${b} B`
  if (abs < 1_048_576)    return `${(b / 1_024).toFixed(1)} KB`
  if (abs < 1_073_741_824) return `${(b / 1_048_576).toFixed(1)} MB`
  return `${(b / 1_073_741_824).toFixed(2)} GB`
}

function sizeDeltaLabel(delta: number): string {
  if (delta === 0) return 'Unchanged'
  return `${delta > 0 ? '+' : ''}${fmtBytes(delta)}`
}

// Electron renderer can load file:// paths directly
function toImgSrc(absPath: string | null): string | null {
  if (!absPath) return null
  // Convert backslashes to forward slashes for file URLs
  const normalized = absPath.replace(/\\/g, '/')
  return `file:///${normalized.replace(/^\/+/, '')}`
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DeltaRow({ label, before, after }: { label: string; before: string; after: string }) {
  const changed = before !== after
  return (
    <div style={{ display: 'flex', gap: 0, fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }}>
      <div style={{ width: 110, color: '#4e5870', flexShrink: 0, paddingRight: 8 }}>{label}</div>
      <div style={{ flex: 1, color: changed ? '#e84040' : '#4e5870', textDecoration: changed ? 'line-through' : 'none' }}>{before}</div>
      <div style={{ width: 14, color: '#2f3a54', textAlign: 'center' }}>→</div>
      <div style={{ flex: 1, color: changed ? '#2dbd6e' : '#4e5870' }}>{after}</div>
    </div>
  )
}

function FallbackBanner({ reason, ueAvailable }: { reason: string; ueAvailable: boolean }) {
  return (
    <div style={{
      margin: '12px 16px 0', padding: '8px 12px',
      background: ueAvailable ? '#4a9eff18' : '#f5a62318',
      border: `1px solid ${ueAvailable ? '#4a9eff44' : '#f5a62344'}`,
      borderRadius: 4,
      fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
      color: ueAvailable ? '#4a9eff' : '#f5a623',
    }}>
      {ueAvailable ? 'ℹ' : '⚠'} {reason}
    </div>
  )
}

function ImagePane({
  label, src, width, height, format, sizeBytes,
}: {
  label: string
  src: string | null
  width?: number
  height?: number
  format?: string
  sizeBytes: number
}) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
      <div style={{
        padding: '4px 10px', background: '#13161e',
        borderBottom: '1px solid #1e2840',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4e5870' }}>{label}</span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#2f3a54' }}>
          {width && height ? `${width}×${height}` : ''}{format ? ` · ${format}` : ''} · {fmtBytes(sizeBytes)}
        </span>
      </div>
      <div style={{
        flex: 1, overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#0b0d13',
        backgroundImage: 'repeating-conic-gradient(#13161e 0% 25%, transparent 0% 50%)',
        backgroundSize: '16px 16px',
      }}>
        {src ? (
          <img
            src={src}
            alt={label}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
          />
        ) : (
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#2f3a54' }}>
            Preview unavailable
          </span>
        )}
      </div>
    </div>
  )
}

function MetadataTable({ delta }: { delta: Extract<AssetDelta, { kind: 'metadata' }> }) {
  const keys = Array.from(new Set([...Object.keys(delta.before), ...Object.keys(delta.after)]))
  return (
    <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {keys.map(k => (
        <DeltaRow
          key={k}
          label={k}
          before={delta.before[k] ?? '—'}
          after={delta.after[k] ?? '—'}
        />
      ))}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

const ASSET_TYPE_LABELS: Record<string, string> = {
  texture:    'Texture',
  audio:      'Audio',
  video:      'Video',
  level:      'Level',
  'generic-ue': 'UE Asset',
  binary:     'Binary',
}

export function AssetDiffViewer({ file, repoPath, staged }: AssetDiffViewerProps) {
  const [result,  setResult]  = useState<AssetDiffResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const leftRef  = 'HEAD'
  const rightRef = staged ? 'INDEX' : 'WORKING'

  useEffect(() => {
    setResult(null)
    setLoading(true)
    setError(null)

    ipc.assetDiffPreview(repoPath, file.path, leftRef, rightRef)
      .then(setResult)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [repoPath, file.path, staged])

  const filename = file.path.split('/').pop() ?? file.path
  const typeLabel = result ? (ASSET_TYPE_LABELS[result.assetType] ?? 'Binary') : ''

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0b0d13' }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 16px', background: '#13161e', borderBottom: '1px solid #1e2840',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#c4cad8' }}>{filename}</span>
          {typeLabel && (
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
              padding: '1px 6px', borderRadius: 3,
              background: '#1a1e2a', border: '1px solid #252d42', color: '#4e5870',
            }}>{typeLabel}</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#2f3a54' }}>
            {leftRef} → {rightRef}
          </span>
          <button
            onClick={() => ipc.openExternal(`unreal://${repoPath}/${file.path}`).catch(() => {})}
            style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
              padding: '2px 8px', borderRadius: 3, cursor: 'pointer',
              background: 'transparent', border: '1px solid #252d42',
              color: '#4e5870',
            }}
            onMouseEnter={e => { (e.target as HTMLElement).style.borderColor = '#e8622f'; (e.target as HTMLElement).style.color = '#e8622f' }}
            onMouseLeave={e => { (e.target as HTMLElement).style.borderColor = '#252d42'; (e.target as HTMLElement).style.color = '#4e5870' }}
          >
            Open in Unreal
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#4e5870', animation: 'pulse 1.5s infinite' }}>
            Loading preview…
          </span>
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div style={{ margin: 16, padding: '8px 12px', background: '#e8404018', border: '1px solid #e8404044', borderRadius: 4 }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#e84040' }}>{error}</span>
        </div>
      )}

      {/* Result */}
      {!loading && result && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Fallback / UE unavailability banner */}
          {result.fallbackReason && (
            <FallbackBanner reason={result.fallbackReason} ueAvailable={result.ueAvailable} />
          )}

          {/* Image panes — textures and UE assets with extracted thumbnails */}
          {result.delta.kind === 'texture' && (
            <>
              <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
                <ImagePane
                  label="Before"
                  src={toImgSrc(result.left.previewPath)}
                  width={result.left.width}
                  height={result.left.height}
                  format={result.left.format}
                  sizeBytes={result.left.sizeBytes}
                />
                <div style={{ width: 1, background: '#1e2840', flexShrink: 0 }} />
                <ImagePane
                  label="After"
                  src={toImgSrc(result.right.previewPath)}
                  width={result.right.width}
                  height={result.right.height}
                  format={result.right.format}
                  sizeBytes={result.right.sizeBytes}
                />
              </div>

              {/* Delta strip */}
              <div style={{
                flexShrink: 0, padding: '8px 16px',
                borderTop: '1px solid #1e2840', background: '#0d0f14',
                display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center',
              }}>
                {result.delta.widthBefore > 0 && result.delta.widthAfter > 0 && (
                  <DeltaRow
                    label="Dimensions"
                    before={`${result.delta.widthBefore}×${result.delta.heightBefore}`}
                    after={`${result.delta.widthAfter}×${result.delta.heightAfter}`}
                  />
                )}
                {result.delta.formatBefore !== result.delta.formatAfter ||
                  (result.delta.formatBefore !== 'UE Asset (.uasset)' && result.delta.formatBefore !== 'Level (.umap)') ? (
                  <DeltaRow label="Format" before={result.delta.formatBefore} after={result.delta.formatAfter} />
                ) : (
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4e5870' }}>
                    {result.delta.formatBefore}
                  </span>
                )}
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: result.delta.sizeDelta > 0 ? '#f5a623' : result.delta.sizeDelta < 0 ? '#2dbd6e' : '#4e5870' }}>
                  Size {sizeDeltaLabel(result.delta.sizeDelta)}
                </div>
              </div>
            </>
          )}

          {/* Metadata table for UE assets without thumbnails, audio, video, and other binaries */}
          {result.delta.kind === 'metadata' && (
            <div style={{ overflow: 'auto', padding: '4px 0' }}>
              <MetadataTable delta={result.delta} />
            </div>
          )}

          {result.delta.kind === 'unavailable' && (
            <div style={{ padding: '12px 16px' }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#2f3a54' }}>
                {result.delta.reason}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

import React, { useState, useEffect, useRef } from 'react'
import { ipc, CommitEntry } from '@/ipc'
import { useAssetViewerStore } from '@/stores/assetViewerStore'

function toImgSrc(absPath: string | null): string | null {
  if (!absPath) return null
  const normalized = absPath.replace(/\\/g, '/')
  return `file:///${normalized.replace(/^\/+/, '')}`
}

function timeAgo(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 60)     return 'just now'
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(ts).toLocaleDateString()
}

interface VersionCard {
  commit: CommitEntry
  thumb: string | null
  loading: boolean
}

export function AssetViewerPanel() {
  const { repoPath, filePath, isOpen, close } = useAssetViewerStore()

  const [zoom,         setZoom]         = useState(1)
  const [fullscreen,   setFullscreen]   = useState(false)
  const [thumbnail,    setThumbnail]    = useState<string | null>(null)
  const [thumbLoading, setThumbLoading] = useState(false)
  const [selectedRef,  setSelectedRef]  = useState('WORKING')
  const [versions,     setVersions]     = useState<VersionCard[]>([])
  const [verLoading,   setVerLoading]   = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const filename   = filePath?.replace(/\\/g, '/').split('/').pop() ?? ''
  const isUEAsset  = /\.(uasset|umap|udk|upk)$/i.test(filePath ?? '')
  const isImgAsset = /\.(png|jpg|jpeg|tga|bmp|tiff|tif|dds|exr|hdr)$/i.test(filePath ?? '')

  // Load thumbnail when file/ref changes
  useEffect(() => {
    if (!repoPath || !filePath || !isOpen) return
    if (!isUEAsset && !isImgAsset) return
    setThumbLoading(true)
    setThumbnail(null)
    ipc.assetRenderThumbnail(repoPath, filePath, selectedRef)
      .then(p => setThumbnail(p))
      .catch(() => {})
      .finally(() => setThumbLoading(false))
  }, [repoPath, filePath, selectedRef, isOpen])

  // Load version history when file changes
  useEffect(() => {
    if (!repoPath || !filePath || !isOpen) return
    setVersions([])
    setVerLoading(true)
    ipc.gitFileLog(repoPath, filePath, 20)
      .then(commits => {
        const cards: VersionCard[] = commits.map(c => ({ commit: c, thumb: null, loading: isUEAsset || isImgAsset }))
        setVersions(cards)
        if (!isUEAsset && !isImgAsset) return
        commits.forEach((c, i) => {
          ipc.assetRenderThumbnail(repoPath, filePath, c.hash)
            .then(p => setVersions(prev => prev.map((v, idx) => idx === i ? { ...v, thumb: p, loading: false } : v)))
            .catch(() => setVersions(prev => prev.map((v, idx) => idx === i ? { ...v, loading: false } : v)))
        })
      })
      .catch(() => setVersions([]))
      .finally(() => setVerLoading(false))
  }, [repoPath, filePath, isOpen])

  // Reset state when panel closes or file changes
  useEffect(() => {
    if (!isOpen) {
      setZoom(1)
      setFullscreen(false)
      setSelectedRef('WORKING')
      setThumbnail(null)
      setVersions([])
    }
  }, [isOpen])

  useEffect(() => {
    setZoom(1)
    setSelectedRef('WORKING')
  }, [filePath])

  const adjustZoom = (delta: number) =>
    setZoom(z => Math.max(0.1, Math.min(8, Math.round((z + delta) * 100) / 100)))

  if (!isOpen || !repoPath || !filePath) return null

  const imgSrc  = toImgSrc(thumbnail)
  const panelW  = fullscreen ? '100%' : 400

  return (
    <div
      ref={panelRef}
      style={{
        position: 'absolute', top: 0, right: 0, bottom: 0,
        width: panelW,
        display: 'flex', flexDirection: 'column',
        background: '#0b0d13',
        borderLeft: '1px solid #1e2840',
        zIndex: 20,
        boxShadow: '-8px 0 40px rgba(0,0,0,0.5)',
        transition: 'width 0.2s ease',
      }}
    >
      {/* ── Header ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '9px 12px', borderBottom: '1px solid #1e2840',
        background: '#0f1118', flexShrink: 0,
      }}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, color: '#e8622f' }}>
          <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5 6h6M5 9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>

        <span style={{
          flex: 1, fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 600,
          color: '#c4cad8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{filename}</span>

        {selectedRef !== 'WORKING' && (
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
            background: 'rgba(232,98,47,0.15)', border: '1px solid rgba(232,98,47,0.3)',
            borderRadius: 3, padding: '2px 6px', color: '#e8622f', flexShrink: 0,
          }}>{selectedRef.slice(0, 7)}</span>
        )}

        <HeaderBtn
          title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={() => setFullscreen(f => !f)}
        >
          {fullscreen ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 4h3V1M9 4H6V1M1 6h3v3M9 6H6v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M4 1H1v3M6 1h3v3M4 9H1V6M6 9h3V6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </HeaderBtn>

        <HeaderBtn title="Close" onClick={close} danger>
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
            <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </HeaderBtn>
      </div>

      {/* ── Preview area ── */}
      <div style={{
        flex: 1, position: 'relative', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#0b0d13',
        backgroundImage: 'repeating-conic-gradient(#13161e 0% 25%, transparent 0% 50%)',
        backgroundSize: '20px 20px',
      }}>
        {thumbLoading ? (
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#4e5870',
            animation: 'pulse 1.5s infinite',
          }}>Loading…</span>
        ) : imgSrc ? (
          <img
            src={imgSrc}
            alt={filename}
            style={{
              maxWidth: '100%', maxHeight: '100%',
              transform: `scale(${zoom})`,
              transformOrigin: 'center center',
              objectFit: 'contain', display: 'block',
              transition: 'transform 0.15s ease',
            }}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
              <rect x="6" y="4" width="28" height="32" rx="3" stroke="#1e2840" strokeWidth="1.5" />
              <path d="M13 15h14M13 21h10M13 27h8" stroke="#1e2840" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#2f3a54',
            }}>No preview available</span>
          </div>
        )}
      </div>

      {/* ── Zoom controls ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '7px 12px', borderTop: '1px solid #1e2840',
        background: '#0f1118', flexShrink: 0,
      }}>
        <ZoomBtn title="Zoom out (−25%)" onClick={() => adjustZoom(-0.25)}>−</ZoomBtn>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#8b94b0',
          minWidth: 40, textAlign: 'center', userSelect: 'none',
        }}>{Math.round(zoom * 100)}%</span>
        <ZoomBtn title="Zoom in (+25%)" onClick={() => adjustZoom(0.25)}>+</ZoomBtn>
        <ZoomBtn title="Reset to 100%" onClick={() => setZoom(1)} label="Fit" />

        {selectedRef !== 'WORKING' && (
          <>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => setSelectedRef('WORKING')}
              title="Return to current working copy"
              style={{
                height: 24, padding: '0 9px', borderRadius: 4,
                background: 'transparent', border: '1px solid rgba(232,98,47,0.3)',
                color: '#e8622f', cursor: 'pointer', fontSize: 10,
                fontFamily: "'IBM Plex Sans', system-ui",
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(232,98,47,0.08)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >← Current</button>
          </>
        )}
      </div>

      {/* ── Version history strip ── */}
      <div style={{ flexShrink: 0, borderTop: '1px solid #1e2840', background: '#0d0f14' }}>
        <div style={{
          padding: '7px 12px 4px',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{
            fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9.5, fontWeight: 700,
            color: '#2f3a54', letterSpacing: '0.1em', textTransform: 'uppercase',
          }}>
            Versions
          </span>
          {verLoading && (
            <div style={{
              width: 10, height: 10, borderRadius: '50%',
              border: '1.5px solid #1e2840', borderTopColor: '#4e5870',
              animation: 'spin 0.8s linear infinite', flexShrink: 0,
            }} />
          )}
          {!verLoading && versions.length > 0 && (
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
              color: '#344057', background: '#131720',
              border: '1px solid #1e2840', borderRadius: 10,
              padding: '0 5px', lineHeight: '16px',
            }}>{versions.length}</span>
          )}
        </div>

        <div style={{
          display: 'flex', gap: 7, overflowX: 'auto', padding: '4px 12px 10px',
          scrollbarWidth: 'thin', scrollbarColor: '#1e2840 transparent',
        }}>
          {!verLoading && versions.length === 0 && (
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#2f3a54',
              paddingTop: 4,
            }}>No version history</span>
          )}

          {versions.map((v) => {
            const isSelected = selectedRef === v.commit.hash
            const thumbSrc   = toImgSrc(v.thumb)
            return (
              <button
                key={v.commit.hash}
                onClick={() => setSelectedRef(v.commit.hash)}
                title={`${v.commit.message}\n${v.commit.author} · ${timeAgo(v.commit.timestamp)}`}
                style={{
                  flexShrink: 0, width: 68, display: 'flex', flexDirection: 'column', gap: 4,
                  background: isSelected ? 'rgba(232,98,47,0.06)' : 'transparent',
                  border: `1px solid ${isSelected ? 'rgba(232,98,47,0.45)' : '#1e2840'}`,
                  borderRadius: 6, padding: 5, cursor: 'pointer',
                  boxShadow: isSelected ? '0 0 0 1px rgba(232,98,47,0.15)' : 'none',
                  transition: 'all 0.12s',
                }}
                onMouseEnter={e => { if (!isSelected) { e.currentTarget.style.borderColor = '#2f3a54'; e.currentTarget.style.background = '#131720' } }}
                onMouseLeave={e => { if (!isSelected) { e.currentTarget.style.borderColor = '#1e2840'; e.currentTarget.style.background = 'transparent' } }}
              >
                {/* Thumbnail swatch */}
                <div style={{
                  width: '100%', aspectRatio: '1', borderRadius: 4, overflow: 'hidden',
                  background: '#0b0d13',
                  backgroundImage: 'repeating-conic-gradient(#13161e 0% 25%, transparent 0% 50%)',
                  backgroundSize: '8px 8px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {thumbSrc ? (
                    <img src={thumbSrc} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                  ) : v.loading ? (
                    <div style={{
                      width: 12, height: 12, borderRadius: '50%',
                      border: '1.5px solid #1e2840', borderTopColor: '#4e5870',
                      animation: 'spin 0.8s linear infinite',
                    }} />
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <rect x="2" y="2" width="12" height="12" rx="2" stroke="#2f3a54" strokeWidth="1.2" />
                    </svg>
                  )}
                </div>

                {/* Commit meta */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                  <span style={{
                    fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
                    color: isSelected ? '#e8622f' : '#4e5870',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{v.commit.hash.slice(0, 7)}</span>
                  <span style={{
                    fontFamily: "'IBM Plex Sans', system-ui", fontSize: 8.5, color: '#2f3a54',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{timeAgo(v.commit.timestamp)}</span>
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function HeaderBtn({ title, onClick, danger, children }: {
  title: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'transparent', border: '1px solid #1e2840', borderRadius: 4,
        color: '#4e5870', cursor: 'pointer', flexShrink: 0, transition: 'all 0.1s',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = danger ? '#e84040' : '#2f3a54'
        e.currentTarget.style.color       = danger ? '#e84040' : '#8b94b0'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = '#1e2840'
        e.currentTarget.style.color       = '#4e5870'
      }}
    >{children}</button>
  )
}

function ZoomBtn({ title, onClick, children, label }: {
  title: string
  onClick: () => void
  children?: React.ReactNode
  label?: string
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        height: 24,
        padding: label ? '0 9px' : undefined,
        width: label ? undefined : 24,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'transparent', border: '1px solid #1e2840', borderRadius: 4,
        color: '#4e5870', cursor: 'pointer', flexShrink: 0,
        fontFamily: label ? "'IBM Plex Sans', system-ui" : 'monospace',
        fontSize: label ? 10 : 14, transition: 'all 0.1s',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = '#2f3a54'; e.currentTarget.style.color = '#8b94b0' }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = '#1e2840'; e.currentTarget.style.color = '#4e5870' }}
    >{label ?? children}</button>
  )
}

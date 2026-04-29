import React, { useState, useEffect } from 'react'
import { FileStatus, CommitEntry, ipc } from '@/ipc'

interface BinaryDiffProps {
  file: FileStatus
  repoPath: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(ms: number): string {
  const s = (Date.now() - ms) / 1000
  if (s < 60)      return 'just now'
  if (s < 3600)    return `${Math.floor(s / 60)}m ago`
  if (s < 86400)   return `${Math.floor(s / 3600)}h ago`
  if (s < 604800)  return `${Math.floor(s / 86400)}d ago`
  if (s < 2592000) return `${Math.floor(s / 604800)}w ago`
  return `${Math.floor(s / 2592000)}mo ago`
}

function authorColor(name: string): string {
  const P = ['#4d9dff', '#2ec573', '#f5a832', '#e8622f', '#a27ef0', '#1abc9c', '#e84545', '#ff6b9d']
  let h = 0
  for (const c of name) h = ((h * 31) + c.charCodeAt(0)) >>> 0
  return P[h % P.length]
}

function TimelineEntry({ commit, isLast }: { commit: CommitEntry; isLast: boolean }) {
  const color = authorColor(commit.author)
  const initials = commit.author.split(/\s+/).map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase()
  const msg = commit.message.split('\n')[0]
  const ago = timeAgo(commit.timestamp * 1000)

  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
        <div style={{
          width: 26, height: 26, borderRadius: '50%', marginTop: 6,
          background: `${color}18`, border: `1.5px solid ${color}55`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700, color,
        }}>{initials}</div>
        {!isLast && <div style={{ width: 1, flex: 1, minHeight: 6, background: '#1e2840' }} />}
      </div>
      <div style={{ flex: 1, paddingTop: 8, paddingBottom: isLast ? 0 : 10, minWidth: 0 }}>
        <div style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
          color: '#c4cad8', lineHeight: 1.5, marginBottom: 3,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{msg}</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#4e5870' }}>{commit.author}</span>
          <span style={{ color: '#2f3a54' }}>·</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4e5870' }}>{ago}</span>
          <span style={{ color: '#2f3a54' }}>·</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: '#2f3a54' }}>{commit.hash.slice(0, 7)}</span>
        </div>
      </div>
    </div>
  )
}

// ── Asset classification ───────────────────────────────────────────────────────

interface AssetClass {
  label: string
  color: string
  icon: React.ReactNode
  description: string
}

function classifyAsset(filePath: string): AssetClass {
  const lower = filePath.toLowerCase()
  const fileName = lower.split('/').pop() ?? lower
  const ext = fileName.split('.').pop() ?? ''
  const pathParts = lower.split('/')

  const inDir = (...dirs: string[]) => dirs.some(d => pathParts.includes(d))
  const nameMatches = (...prefixes: string[]) => prefixes.some(p => fileName.startsWith(p + '_') || fileName.startsWith(p.toLowerCase() + '_'))

  // Map / Level
  if (ext === 'umap') return {
    label: 'Map / Level',
    color: '#a27ef0',
    description: 'Unreal level — contains all actors, lighting, and environment data.',
    icon: <MapIcon />,
  }

  // Animation Blueprint
  if (nameMatches('ABP') || inDir('animblueprints', 'anim_blueprints')) return {
    label: 'Animation Blueprint',
    color: '#4d9dff',
    description: 'Controls character animation logic using a state machine graph.',
    icon: <AnimBPIcon />,
  }

  // Widget Blueprint
  if (nameMatches('WBP') || inDir('ui', 'widgets', 'hud', 'menus')) return {
    label: 'Widget Blueprint',
    color: '#f5a832',
    description: 'UMG widget — UI screen, menu, or HUD element.',
    icon: <WidgetIcon />,
  }

  // Blueprint
  if (nameMatches('BP') || inDir('blueprints', 'actors', 'gameplay')) return {
    label: 'Blueprint',
    color: '#4d9dff',
    description: 'Blueprint actor or component — visual scripting logic.',
    icon: <BlueprintIcon />,
  }

  // Material Instance
  if (nameMatches('MI', 'MID') || inDir('materialinstances')) return {
    label: 'Material Instance',
    color: '#2ec573',
    description: 'A parameterized instance of a parent material.',
    icon: <MaterialIcon color="#2ec573" />,
  }

  // Material
  if (nameMatches('M') || inDir('materials', 'material')) return {
    label: 'Material',
    color: '#2ec573',
    description: 'Defines how surfaces render — shader graph asset.',
    icon: <MaterialIcon color="#2ec573" />,
  }

  // Skeletal Mesh
  if (nameMatches('SK') || inDir('characters', 'skeletalmeshes', 'sk_')) return {
    label: 'Skeletal Mesh',
    color: '#e8622f',
    description: 'Animated mesh with skeleton and blend shapes.',
    icon: <MeshIcon />,
  }

  // Static Mesh
  if (nameMatches('SM') || inDir('meshes', 'staticmeshes', 'props', 'environment', 'architecture')) return {
    label: 'Static Mesh',
    color: '#e8622f',
    description: 'Non-animated 3D geometry asset.',
    icon: <MeshIcon />,
  }

  // Texture
  if (nameMatches('T', 'TX') || inDir('textures', 'texture') || ['png', 'tga', 'bmp', 'tiff', 'psd'].includes(ext)) return {
    label: 'Texture',
    color: '#f5a832',
    description: 'Image asset — diffuse, normal map, roughness, etc.',
    icon: <TextureIcon />,
  }

  // Niagara / Particle
  if (nameMatches('NS', 'P', 'FX') || inDir('niagara', 'particles', 'effects', 'vfx')) return {
    label: ext === 'uasset' && nameMatches('NS') ? 'Niagara System' : 'Particle Effect',
    color: '#e8622f',
    description: 'Visual effect — particle system or Niagara emitter.',
    icon: <ParticleIcon />,
  }

  // Animation Sequence
  if (nameMatches('A', 'AS') || inDir('animations', 'anim')) return {
    label: 'Animation',
    color: '#4d9dff',
    description: 'Animation sequence or montage for a skeletal mesh.',
    icon: <AnimIcon />,
  }

  // Sound
  if (nameMatches('S', 'SW', 'SC', 'SA') || inDir('sounds', 'audio', 'sound') || ['wav', 'mp3', 'ogg', 'flac'].includes(ext)) return {
    label: 'Sound Asset',
    color: '#1abc9c',
    description: 'Sound wave, cue, or audio mix asset.',
    icon: <SoundIcon />,
  }

  // Data Asset
  if (nameMatches('DA') || inDir('dataassets', 'data', 'datatable')) return {
    label: 'Data Asset',
    color: '#f5a832',
    description: 'Structured game data — data table, data asset, or config.',
    icon: <DataIcon />,
  }

  // Generic Unreal asset
  if (ext === 'uasset') return {
    label: 'Unreal Asset',
    color: '#8b94b0',
    description: 'Unreal Engine binary asset. Type could not be inferred from path.',
    icon: <GenericUEIcon />,
  }

  // Other binary formats
  const LABELS: Record<string, [string, string]> = {
    pak:  ['PAK Archive',         '#8b94b0'],
    fbx:  ['FBX Model',           '#e8622f'],
    obj:  ['OBJ Model',           '#e8622f'],
    exe:  ['Executable',          '#e84545'],
    dll:  ['DLL Library',         '#e84545'],
    zip:  ['ZIP Archive',         '#8b94b0'],
    '7z': ['7-Zip Archive',       '#8b94b0'],
    ttf:  ['TrueType Font',       '#a27ef0'],
    otf:  ['OpenType Font',       '#a27ef0'],
    jpg:  ['JPEG Image',          '#f5a832'],
    jpeg: ['JPEG Image',          '#f5a832'],
    gif:  ['GIF Image',           '#f5a832'],
    mp3:  ['MP3 Audio',           '#1abc9c'],
    wav:  ['WAV Audio',           '#1abc9c'],
    ogg:  ['OGG Audio',           '#1abc9c'],
  }
  const entry = LABELS[ext]
  return {
    label: entry ? entry[0] : `${ext.toUpperCase() || 'Binary'} File`,
    color: entry ? entry[1] : '#4e5870',
    description: 'Binary file — cannot be shown as text.',
    icon: <GenericIcon ext={ext} />,
  }
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function MapIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <rect x="4" y="6" width="20" height="16" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 10h20" stroke="currentColor" strokeWidth="1.2" />
      <path d="M10 10v12" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" />
      <path d="M18 10v12" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" />
      <circle cx="14" cy="17" r="2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function BlueprintIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <rect x="4" y="4" width="20" height="20" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="10" cy="14" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="18" cy="10" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="18" cy="18" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M12 14h2M18 12v4" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function AnimBPIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <circle cx="7" cy="14" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="21" cy="9" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="21" cy="19" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9 14 C13 14 13 9 19 9" stroke="currentColor" strokeWidth="1.3" fill="none" />
      <path d="M9 14 C13 14 13 19 19 19" stroke="currentColor" strokeWidth="1.3" fill="none" />
    </svg>
  )
}

function WidgetIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <rect x="4" y="5" width="20" height="18" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <rect x="8" y="9" width="8" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 18h12M8 21h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function MaterialIcon({ color }: { color: string }) {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <circle cx="14" cy="14" r="9" stroke="currentColor" strokeWidth="1.4" />
      <ellipse cx="14" cy="14" rx="5" ry="9" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 14h18" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function MeshIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <path d="M14 4 L24 20 H4 Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M14 4 L4 20" stroke="currentColor" strokeWidth="1" strokeOpacity="0.5" />
      <path d="M14 4 L24 20" stroke="currentColor" strokeWidth="1" strokeOpacity="0.5" />
      <path d="M9 12 L19 12" stroke="currentColor" strokeWidth="1" strokeOpacity="0.5" />
    </svg>
  )
}

function TextureIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <rect x="4" y="4" width="20" height="20" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 19 L10 13 L15 18 L19 14 L24 19" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ParticleIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <circle cx="14" cy="14" r="2.5" fill="currentColor" fillOpacity="0.4" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8"  cy="8"  r="1.5" stroke="currentColor" strokeWidth="1.1" strokeOpacity="0.6" />
      <circle cx="20" cy="8"  r="1.5" stroke="currentColor" strokeWidth="1.1" strokeOpacity="0.6" />
      <circle cx="8"  cy="20" r="1.5" stroke="currentColor" strokeWidth="1.1" strokeOpacity="0.6" />
      <circle cx="20" cy="20" r="1.5" stroke="currentColor" strokeWidth="1.1" strokeOpacity="0.6" />
      <circle cx="14" cy="6"  r="1"   stroke="currentColor" strokeWidth="1.1" strokeOpacity="0.4" />
      <circle cx="14" cy="22" r="1"   stroke="currentColor" strokeWidth="1.1" strokeOpacity="0.4" />
    </svg>
  )
}

function AnimIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <path d="M6 20 Q10 8 14 14 Q18 20 22 8" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <circle cx="6"  cy="20" r="1.5" fill="currentColor" />
      <circle cx="14" cy="14" r="1.5" fill="currentColor" />
      <circle cx="22" cy="8"  r="1.5" fill="currentColor" />
    </svg>
  )
}

function SoundIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <path d="M8 10 L8 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 7 L12 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M16 10 L16 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M20 12 L20 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function DataIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <rect x="4" y="5" width="20" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="4" y="12" width="20" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="4" y="19" width="20" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function GenericUEIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <polygon points="14,3 25,9 25,21 14,27 3,21 3,9" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinejoin="round" />
      <text x="14" y="18" textAnchor="middle" fill="currentColor" fontSize="7" fontFamily="sans-serif" fontWeight="700">UE</text>
    </svg>
  )
}

function GenericIcon({ ext }: { ext: string }) {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <path d="M7 4h10l6 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" stroke="currentColor" strokeWidth="1.4" />
      <path d="M17 4v6h6" stroke="currentColor" strokeWidth="1.3" />
      <text x="14" y="21" textAnchor="middle" fill="currentColor" fontSize="6" fontFamily="monospace" fontWeight="700">
        {ext.toUpperCase().slice(0, 4)}
      </text>
    </svg>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function BinaryDiff({ file, repoPath }: BinaryDiffProps) {
  const [history, setHistory]         = useState<CommitEntry[] | null>(null)
  const [histLoading, setHistLoading] = useState(true)
  const [thumbnail, setThumbnail]     = useState<string | null>(null)

  const isUEAsset = /\.(uasset|umap|upk|udk)$/i.test(file.path)
  const thumbRef  = file.staged ? 'INDEX' : 'WORKING'

  useEffect(() => {
    setHistLoading(true)
    setHistory(null)
    ipc.gitFileLog(repoPath, file.path, 60)
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setHistLoading(false))
  }, [repoPath, file.path])

  useEffect(() => {
    if (!isUEAsset) { setThumbnail(null); return }
    setThumbnail(null)
    ipc.assetRenderThumbnail(repoPath, file.path, thumbRef)
      .then(p => setThumbnail(p))
      .catch(() => {})
  }, [repoPath, file.path, thumbRef, isUEAsset])

  const asset    = classifyAsset(file.path)
  const fileName = file.path.replace(/\\/g, '/').split('/').pop() ?? file.path
  const ext      = file.path.split('.').pop()?.toLowerCase() ?? ''

  // Convert absolute path to file:// URL for Electron renderer
  const thumbSrc = thumbnail
    ? `file:///${thumbnail.replace(/\\/g, '/').replace(/^\/+/, '')}`
    : null

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── Asset info ─────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        padding: '24px 32px 18px', gap: 0, flexShrink: 0,
      }}>
        <div style={{
          width: 72, height: 72, borderRadius: 14, overflow: 'hidden',
          background: thumbSrc ? '#0b0d13' : `${asset.color}12`,
          border: thumbSrc ? '1px solid rgba(255,255,255,0.07)' : `1.5px solid ${asset.color}30`,
          backgroundImage: thumbSrc ? 'repeating-conic-gradient(#13161e 0% 25%, transparent 0% 50%)' : 'none',
          backgroundSize: '8px 8px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: asset.color, marginBottom: 14, flexShrink: 0,
          boxShadow: thumbSrc ? '0 4px 18px rgba(0,0,0,0.5)' : 'none',
        }}>
          {thumbSrc ? (
            <img
              src={thumbSrc}
              alt="Asset thumbnail"
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
            />
          ) : (
            asset.icon
          )}
        </div>

        <div style={{
          fontFamily: "'IBM Plex Sans', system-ui", fontSize: 15, fontWeight: 700,
          color: asset.color, marginBottom: 5, letterSpacing: '0.01em',
        }}>{asset.label}</div>

        <div style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
          color: '#8b94b0', marginBottom: 10, textAlign: 'center',
          maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }} title={file.path}>{fileName}</div>

        <div style={{
          fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12,
          color: '#4e5870', textAlign: 'center', maxWidth: 300, lineHeight: 1.6,
          marginBottom: 14,
        }}>{asset.description}</div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
            background: '#1d2235', color: '#4e5870',
            borderRadius: 8, padding: '3px 10px', letterSpacing: '0.04em',
          }}>{ext.toUpperCase() || 'BINARY'}</span>
          <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#4e5870' }}>
            Binary — no text diff
          </span>
        </div>
      </div>

      {/* ── Asset History Timeline ─────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderTop: '1px solid #1a2030' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 24px 8px', flexShrink: 0,
        }}>
          <span style={{
            fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, fontWeight: 600,
            color: '#4e5870', letterSpacing: '0.07em', textTransform: 'uppercase',
          }}>Asset History</span>
          {history && history.length > 0 && (
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
              color: '#4e5870', background: '#1a2030',
              borderRadius: 8, padding: '1px 6px',
            }}>{history.length} commits</span>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 24px 16px' }}>
          {histLoading && (
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#4e5870' }}>
              Loading history…
            </span>
          )}
          {!histLoading && history?.length === 0 && (
            <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#4e5870' }}>
              No commit history found for this file.
            </span>
          )}
          {!histLoading && history && history.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {history.map((commit, i) => (
                <TimelineEntry key={commit.hash} commit={commit} isLast={i === history.length - 1} />
              ))}
            </div>
          )}
        </div>
      </div>

    </div>
  )
}

import React, { useEffect, useState } from 'react'
import { ipc, BlameEntry, CommitEntry, DiffContent } from '@/ipc'
import { TextDiff } from '@/components/diff/TextDiff'
import { FilePathText } from '@/components/ui/FilePathText'
import { CommitContextMenu } from '@/components/shared/CommitContextMenu'
import { CommitFilesModal } from '@/components/shared/CommitFilesModal'

const ASSET_EXTS = new Set([
  'uasset', 'umap', 'upk', 'udk',
  'png', 'jpg', 'jpeg', 'tga', 'bmp', 'tiff', 'tif', 'dds', 'exr', 'hdr',
  'wav', 'mp3', 'ogg', 'flac',
  'mp4', 'mov', 'avi', 'mkv',
])

export function isPreviewAsset(filePath: string): boolean {
  return ASSET_EXTS.has(filePath.split('.').pop()?.toLowerCase() ?? '')
}

function timeAgo(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 60)     return 'just now'
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(ts).toLocaleDateString()
}

function authorColor(author: string): string {
  const palette = ['#4d9dff', '#a27ef0', '#2ec573', '#f5a832', '#e8622f', '#1abc9c', '#e91e63']
  let h = 0
  for (let i = 0; i < author.length; i++) h = (h * 31 + author.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

function initials(author: string): string {
  const parts = author.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return author.slice(0, 2).toUpperCase()
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return 'Unknown'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`
}

interface BlameBlock {
  hash: string
  author: string
  timestamp: number
  summary: string
  fromLine: number
  toLine: number
}

function groupBlame(entries: BlameEntry[]): BlameBlock[] {
  const blocks: BlameBlock[] = []
  for (const e of entries) {
    const last = blocks[blocks.length - 1]
    if (last && last.hash === e.hash) {
      last.toLine = e.lineNo
    } else {
      blocks.push({ hash: e.hash, author: e.author, timestamp: e.timestamp, summary: e.summary, fromLine: e.lineNo, toLine: e.lineNo })
    }
  }
  return blocks
}

export function BlameSection({ entries, loading }: { entries: BlameEntry[]; loading: boolean }) {
  const blocks = groupBlame(entries)
  return (
    <div style={{ flexShrink: 0, borderTop: '1px solid #1e2436', background: '#0d0f15', maxHeight: 220, overflowY: 'auto' }}>
      <div style={{
        display: 'flex', alignItems: 'center', height: 30, paddingLeft: 12, paddingRight: 10,
        borderBottom: '1px solid #1e2436', position: 'sticky', top: 0, background: '#0d0f15', zIndex: 1,
      }}>
        <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, fontWeight: 700, color: '#3a4260', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          Blame
        </span>
        {!loading && entries.length > 0 && (
          <span style={{ marginLeft: 8, fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#3a4260' }}>
            {blocks.length} block{blocks.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      {loading ? (
        <div style={{ padding: '10px 12px', fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#3a4260' }}>Loading...</div>
      ) : blocks.length === 0 ? (
        <div style={{ padding: '10px 12px', fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#3a4260' }}>No blame data</div>
      ) : blocks.map((b, i) => {
        const col = authorColor(b.author)
        const lines = b.fromLine === b.toLine ? `L${b.fromLine}` : `L${b.fromLine}-${b.toLine}`
        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            height: 28, paddingLeft: 12, paddingRight: 10,
            borderBottom: '1px solid #0d0f1580',
            borderLeft: `3px solid ${col}55`,
            background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
          }}>
            <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: col, flexShrink: 0, minWidth: 50 }}>
              {b.hash.slice(0, 7)}
            </span>
            <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#8b94b0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {b.author}
            </span>
            <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#3a4260', flexShrink: 0 }}>
              {timeAgo(b.timestamp)}
            </span>
            <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 9, color: '#2a3040', flexShrink: 0, minWidth: 60, textAlign: 'right' }}>
              {lines}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
      <div style={{
        width: 44, height: 44, borderRadius: 11,
        background: 'rgba(255,255,255,0.02)', border: '1px solid #1d2535',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="22" height="22" viewBox="0 0 36 36" fill="none">
          <rect x="7" y="5" width="22" height="26" rx="3" stroke="#283047" strokeWidth="1.5" />
          <path d="M12 12h12M12 17h8M12 22h10" stroke="#283047" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
      <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 13, color: '#2e3a50' }}>
        {message}
      </span>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '78px minmax(0, 1fr)', gap: 8, padding: '7px 12px', borderBottom: '1px solid #121722' }}>
      <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, fontWeight: 700, color: '#3a4260', textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10.5, color: '#8b94b0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={value}>{value}</span>
    </div>
  )
}

function FileDetails({ repoPath, filePath, hash, remoteUrl = null }: { repoPath: string; filePath: string; hash: string; remoteUrl?: string | null }) {
  const [history, setHistory] = useState<CommitEntry[]>([])
  const [histLoading, setHistLoading] = useState(true)
  const [metadata, setMetadata] = useState<Record<string, string>>({})
  const [sizeBytes, setSizeBytes] = useState<number | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ commit: CommitEntry; x: number; y: number } | null>(null)
  const [filesModalCommit, setFilesModalCommit] = useState<CommitEntry | null>(null)

  const loadHistory = React.useCallback(() => {
    setHistLoading(true)
    return ipc.gitFileLog(repoPath, filePath, 12)
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setHistLoading(false))
  }, [repoPath, filePath])

  useEffect(() => {
    setHistory([])
    setMetadata({})
    setSizeBytes(null)
    loadHistory()

    ipc.assetExtractMetadata(repoPath, filePath, hash)
      .then(meta => {
        setMetadata(meta)
        const parsedSize = Number(meta.SizeBytes ?? meta.sizeBytes ?? meta.Size ?? NaN)
        if (Number.isFinite(parsedSize)) setSizeBytes(parsedSize)
      })
      .catch(() => {})
  }, [repoPath, filePath, hash, loadHistory])

  const fileName = filePath.split(/[/\\]/).pop() ?? filePath
  const ext = (filePath.split('.').pop() ?? '').toLowerCase()
  const latest = history[0]
  const assetClass = metadata.AssetClass ?? metadata.Class ?? metadata.ObjectClass

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: '#0d0f15' }}>
      <div style={{ padding: '12px', borderBottom: '1px solid #1e2436' }}>
        <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 13, fontWeight: 700, color: '#dde1f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fileName}>
          {fileName}
        </div>
        <FilePathText path={filePath} style={{ display: 'block', marginTop: 5, fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#3a4260' }} />
      </div>

      <DetailRow label="Type" value={assetClass ?? (ext ? `.${ext}` : 'File')} />
      <DetailRow label="Size" value={formatBytes(sizeBytes)} />
      <DetailRow label="Revision" value={hash} />
      {latest && <DetailRow label="Last Edit" value={`${latest.author} - ${timeAgo(latest.timestamp)}`} />}

      <div style={{
        display: 'flex', alignItems: 'center', height: 30, paddingLeft: 12, paddingRight: 10,
        borderTop: '1px solid #1e2436', borderBottom: '1px solid #181e2e', marginTop: 8,
      }}>
        <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, fontWeight: 700, color: '#2a3040', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          File History
        </span>
      </div>

      {histLoading ? (
        <div style={{ padding: '10px 12px', fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#2a3040' }}>Loading...</div>
      ) : history.length === 0 ? (
        <div style={{ padding: '10px 12px', fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#2a3040' }}>No history available</div>
      ) : history.map((c, i) => {
        const col = authorColor(c.author)
        return (
          <div
            key={c.hash}
            onClick={() => setFilesModalCommit(c)}
            onContextMenu={e => { e.preventDefault(); setCtxMenu({ commit: c, x: e.clientX, y: e.clientY }) }}
            style={{
              display: 'flex', alignItems: 'center', gap: 9,
              minHeight: 38, padding: '7px 12px',
              borderBottom: '1px solid #0f1320',
              background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
              cursor: 'pointer',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
            onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)')}
          >
            <span style={{
              width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
              background: `linear-gradient(135deg, ${col}55, ${col}22)`,
              border: `1px solid ${col}44`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'var(--lg-font-mono)', fontSize: 7.5, fontWeight: 700, color: col,
            }}>{initials(c.author)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#9ba4bc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.message}
              </div>
              <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#3e4a60', marginTop: 1 }}>
                {c.author}
              </div>
            </div>
            <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
              <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#3a4260' }}>{timeAgo(c.timestamp)}</span>
              <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 9, color: '#252d3e' }}>{c.hash.slice(0, 7)}</span>
            </div>
          </div>
        )
      })}

      {ctxMenu && (
        <CommitContextMenu
          commit={ctxMenu.commit}
          repoPath={repoPath}
          remoteUrl={remoteUrl}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          onRefresh={loadHistory}
        />
      )}

      {filesModalCommit && (
        <CommitFilesModal
          repoPath={repoPath}
          commit={filesModalCommit}
          remoteUrl={remoteUrl}
          onClose={() => setFilesModalCommit(null)}
        />
      )}
    </div>
  )
}

function AssetPanel({ repoPath, filePath, hash, remoteUrl }: { repoPath: string; filePath: string; hash: string; remoteUrl: string | null }) {
  const [thumbSrc, setThumbSrc] = useState<string | null>(null)
  const [thumbLoading, setThumbLoading] = useState(true)

  useEffect(() => {
    setThumbSrc(null)
    setThumbLoading(true)
    ipc.assetRenderThumbnail(repoPath, filePath, hash)
      .then(p => setThumbSrc(p))
      .catch(() => setThumbSrc(null))
      .finally(() => setThumbLoading(false))
  }, [repoPath, filePath, hash])

  const fileName = filePath.split(/[/\\]/).pop() ?? filePath
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0d0f15' }}>
      <div style={{
        flex: 1, minHeight: 180,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: thumbSrc ? '#000' : '#0f1118',
        borderBottom: '1px solid #1e2436', overflow: 'hidden',
      }}>
        {thumbLoading ? (
          <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#2a3040' }}>Loading...</span>
        ) : thumbSrc ? (
          <img src={`file://${thumbSrc}`} alt={fileName} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        ) : (
          <svg width="64" height="64" viewBox="0 0 64 64" fill="none" style={{ color: '#5a6480' }}>
            <rect x="12" y="12" width="40" height="40" rx="6" stroke="currentColor" strokeWidth="2" />
            <path d="M22 24 L32 38 L42 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        )}
      </div>
      <FileDetails repoPath={repoPath} filePath={filePath} hash={hash} remoteUrl={remoteUrl} />
    </div>
  )
}

export function FileDetailsSidePanel({
  repoPath,
  filePath,
  hash = 'HEAD',
  diff,
  diffLoading = false,
  blame,
  blameLoading,
  mode = 'preview',
  emptyMessage = 'Select a file to preview',
  remoteUrl = null,
}: {
  repoPath: string
  filePath: string | null
  hash?: string
  remoteUrl?: string | null
  diff?: DiffContent | null
  diffLoading?: boolean
  blame: BlameEntry[]
  blameLoading: boolean
  mode?: 'preview' | 'details'
  emptyMessage?: string
}) {
  if (!filePath) return <EmptyState message={emptyMessage} />

  if (mode === 'details') {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <FileDetails repoPath={repoPath} filePath={filePath} hash={hash} remoteUrl={remoteUrl} />
        <BlameSection entries={blame} loading={blameLoading} />
      </div>
    )
  }

  if (isPreviewAsset(filePath)) {
    return <AssetPanel repoPath={repoPath} filePath={filePath} hash={hash} remoteUrl={remoteUrl} />
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {diffLoading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0d0f15' }}>
            <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 12, color: '#344057' }}>Loading diff...</span>
          </div>
        )}
        {!diffLoading && diff && <TextDiff diff={diff} />}
        {!diffLoading && !diff && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 13, color: '#2e3a50' }}>No diff available</span>
          </div>
        )}
      </div>
      <BlameSection entries={blame} loading={blameLoading} />
    </div>
  )
}

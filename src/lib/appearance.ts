import type { AppSettings } from '@/ipc'

// ── Theme definitions ─────────────────────────────────────────────────────────

interface ThemeVars {
  '--lg-bg-primary': string
  '--lg-bg-secondary': string
  '--lg-bg-elevated': string
  '--lg-accent': string
  '--lg-accent-hover': string
  '--lg-accent-blue': string
  '--lg-text-primary': string
  '--lg-text-secondary': string
  '--lg-border': string
  '--lg-border-strong': string
  '--lg-glow-accent': string
  '--lg-glow-blue': string
}

export interface ThemeDef {
  id: AppSettings['theme']
  label: string
  preview: { bg: string; panel: string; accent: string }
  vars: ThemeVars
}

export const THEMES: ThemeDef[] = [
  {
    id: 'dark',
    label: 'Dark',
    preview: { bg: '#0b0d13', panel: '#10131c', accent: '#e8622f' },
    vars: {
      '--lg-bg-primary':    '#0b0d13',
      '--lg-bg-secondary':  '#10131c',
      '--lg-bg-elevated':   '#161a27',
      '--lg-accent':        '#e8622f',
      '--lg-accent-hover':  '#f0714d',
      '--lg-accent-blue':   '#4a9eff',
      '--lg-text-primary':  '#e2e6f4',
      '--lg-text-secondary':'#7b8499',
      '--lg-border':        '#1d2535',
      '--lg-border-strong': '#283047',
      '--lg-glow-accent':   '0 0 18px rgba(232,98,47,0.22), 0 0 4px rgba(232,98,47,0.18)',
      '--lg-glow-blue':     '0 0 14px rgba(74,158,255,0.22)',
    },
  },
  {
    id: 'darker',
    label: 'Darker',
    preview: { bg: '#060709', panel: '#0b0d13', accent: '#e8622f' },
    vars: {
      '--lg-bg-primary':    '#060709',
      '--lg-bg-secondary':  '#0b0d13',
      '--lg-bg-elevated':   '#10131c',
      '--lg-accent':        '#e8622f',
      '--lg-accent-hover':  '#f0714d',
      '--lg-accent-blue':   '#4a9eff',
      '--lg-text-primary':  '#e2e6f4',
      '--lg-text-secondary':'#7b8499',
      '--lg-border':        '#1a2030',
      '--lg-border-strong': '#232d40',
      '--lg-glow-accent':   '0 0 18px rgba(232,98,47,0.22), 0 0 4px rgba(232,98,47,0.18)',
      '--lg-glow-blue':     '0 0 14px rgba(74,158,255,0.22)',
    },
  },
  {
    id: 'midnight',
    label: 'Midnight',
    preview: { bg: '#080c18', panel: '#0d1225', accent: '#4d9dff' },
    vars: {
      '--lg-bg-primary':    '#080c18',
      '--lg-bg-secondary':  '#0d1225',
      '--lg-bg-elevated':   '#131c35',
      '--lg-accent':        '#4d9dff',
      '--lg-accent-hover':  '#6aadff',
      '--lg-accent-blue':   '#4d9dff',
      '--lg-text-primary':  '#dde8ff',
      '--lg-text-secondary':'#6878a8',
      '--lg-border':        '#1a2540',
      '--lg-border-strong': '#253560',
      '--lg-glow-accent':   '0 0 18px rgba(77,157,255,0.25), 0 0 4px rgba(77,157,255,0.18)',
      '--lg-glow-blue':     '0 0 14px rgba(77,157,255,0.3)',
    },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    preview: { bg: '#282a36', panel: '#21222c', accent: '#ff79c6' },
    vars: {
      '--lg-bg-primary':    '#282a36',
      '--lg-bg-secondary':  '#21222c',
      '--lg-bg-elevated':   '#2f3044',
      '--lg-accent':        '#ff79c6',
      '--lg-accent-hover':  '#ff92d0',
      '--lg-accent-blue':   '#8be9fd',
      '--lg-text-primary':  '#f8f8f2',
      '--lg-text-secondary':'#6272a4',
      '--lg-border':        '#383a4a',
      '--lg-border-strong': '#44475a',
      '--lg-glow-accent':   '0 0 18px rgba(255,121,198,0.25), 0 0 4px rgba(255,121,198,0.18)',
      '--lg-glow-blue':     '0 0 14px rgba(139,233,253,0.22)',
    },
  },
  {
    id: 'nord',
    label: 'Nord',
    preview: { bg: '#2e3440', panel: '#272c38', accent: '#88c0d0' },
    vars: {
      '--lg-bg-primary':    '#2e3440',
      '--lg-bg-secondary':  '#272c38',
      '--lg-bg-elevated':   '#3b4252',
      '--lg-accent':        '#88c0d0',
      '--lg-accent-hover':  '#9ed4e4',
      '--lg-accent-blue':   '#81a1c1',
      '--lg-text-primary':  '#eceff4',
      '--lg-text-secondary':'#7b88a8',
      '--lg-border':        '#3b4252',
      '--lg-border-strong': '#4c566a',
      '--lg-glow-accent':   '0 0 18px rgba(136,192,208,0.22), 0 0 4px rgba(136,192,208,0.15)',
      '--lg-glow-blue':     '0 0 14px rgba(129,161,193,0.22)',
    },
  },
  {
    id: 'catppuccin',
    label: 'Catppuccin',
    preview: { bg: '#1e1e2e', panel: '#181825', accent: '#cba6f7' },
    vars: {
      '--lg-bg-primary':    '#1e1e2e',
      '--lg-bg-secondary':  '#181825',
      '--lg-bg-elevated':   '#24263e',
      '--lg-accent':        '#cba6f7',
      '--lg-accent-hover':  '#d5b8ff',
      '--lg-accent-blue':   '#89b4fa',
      '--lg-text-primary':  '#cdd6f4',
      '--lg-text-secondary':'#6c7086',
      '--lg-border':        '#313244',
      '--lg-border-strong': '#45475a',
      '--lg-glow-accent':   '0 0 18px rgba(203,166,247,0.22), 0 0 4px rgba(203,166,247,0.18)',
      '--lg-glow-blue':     '0 0 14px rgba(137,180,250,0.22)',
    },
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    preview: { bg: '#1a1b26', panel: '#16161e', accent: '#7aa2f7' },
    vars: {
      '--lg-bg-primary':    '#1a1b26',
      '--lg-bg-secondary':  '#16161e',
      '--lg-bg-elevated':   '#1f2335',
      '--lg-accent':        '#7aa2f7',
      '--lg-accent-hover':  '#8eb3ff',
      '--lg-accent-blue':   '#7aa2f7',
      '--lg-text-primary':  '#c0caf5',
      '--lg-text-secondary':'#565f89',
      '--lg-border':        '#292e42',
      '--lg-border-strong': '#3b4261',
      '--lg-glow-accent':   '0 0 18px rgba(122,162,247,0.25), 0 0 4px rgba(122,162,247,0.18)',
      '--lg-glow-blue':     '0 0 14px rgba(122,162,247,0.3)',
    },
  },
  {
    id: 'ocean',
    label: 'Ocean',
    preview: { bg: '#0a1628', panel: '#0e1c34', accent: '#00d9c8' },
    vars: {
      '--lg-bg-primary':    '#0a1628',
      '--lg-bg-secondary':  '#0e1c34',
      '--lg-bg-elevated':   '#142240',
      '--lg-accent':        '#00d9c8',
      '--lg-accent-hover':  '#1aeadb',
      '--lg-accent-blue':   '#4d9dff',
      '--lg-text-primary':  '#d4e8f0',
      '--lg-text-secondary':'#5a7a94',
      '--lg-border':        '#1a2e44',
      '--lg-border-strong': '#244060',
      '--lg-glow-accent':   '0 0 18px rgba(0,217,200,0.22), 0 0 4px rgba(0,217,200,0.18)',
      '--lg-glow-blue':     '0 0 14px rgba(77,157,255,0.22)',
    },
  },
  {
    id: 'forest',
    label: 'Forest',
    preview: { bg: '#0d1a0d', panel: '#121f12', accent: '#4ade80' },
    vars: {
      '--lg-bg-primary':    '#0d1a0d',
      '--lg-bg-secondary':  '#121f12',
      '--lg-bg-elevated':   '#182618',
      '--lg-accent':        '#4ade80',
      '--lg-accent-hover':  '#5df08d',
      '--lg-accent-blue':   '#34d399',
      '--lg-text-primary':  '#d4f4d4',
      '--lg-text-secondary':'#567856',
      '--lg-border':        '#1e2e1e',
      '--lg-border-strong': '#2a3e2a',
      '--lg-glow-accent':   '0 0 18px rgba(74,222,128,0.22), 0 0 4px rgba(74,222,128,0.18)',
      '--lg-glow-blue':     '0 0 14px rgba(52,211,153,0.22)',
    },
  },
  {
    id: 'rose-pine',
    label: 'Rose Pine',
    preview: { bg: '#191724', panel: '#1f1d2e', accent: '#eb6f92' },
    vars: {
      '--lg-bg-primary':    '#191724',
      '--lg-bg-secondary':  '#1f1d2e',
      '--lg-bg-elevated':   '#26233a',
      '--lg-accent':        '#eb6f92',
      '--lg-accent-hover':  '#f48fb1',
      '--lg-accent-blue':   '#9ccfd8',
      '--lg-text-primary':  '#e0def4',
      '--lg-text-secondary':'#6e6a86',
      '--lg-border':        '#2a2738',
      '--lg-border-strong': '#393552',
      '--lg-glow-accent':   '0 0 18px rgba(235,111,146,0.22), 0 0 4px rgba(235,111,146,0.18)',
      '--lg-glow-blue':     '0 0 14px rgba(156,207,216,0.22)',
    },
  },
  {
    id: 'monokai',
    label: 'Monokai',
    preview: { bg: '#272822', panel: '#1e1f1c', accent: '#a6e22e' },
    vars: {
      '--lg-bg-primary':    '#272822',
      '--lg-bg-secondary':  '#1e1f1c',
      '--lg-bg-elevated':   '#32332e',
      '--lg-accent':        '#a6e22e',
      '--lg-accent-hover':  '#b8f040',
      '--lg-accent-blue':   '#66d9e8',
      '--lg-text-primary':  '#f8f8f2',
      '--lg-text-secondary':'#75715e',
      '--lg-border':        '#3e3d32',
      '--lg-border-strong': '#4e4d42',
      '--lg-glow-accent':   '0 0 18px rgba(166,226,46,0.22), 0 0 4px rgba(166,226,46,0.18)',
      '--lg-glow-blue':     '0 0 14px rgba(102,217,232,0.22)',
    },
  },
]

// ── Font options ───────────────────────────────────────────────────────────────

export const UI_FONTS = [
  'IBM Plex Sans',
  'Inter',
  'Plus Jakarta Sans',
  'Nunito',
  'Geist',
  'system-ui',
  'Segoe UI',
  'Roboto',
]

export const CODE_FONTS = [
  { label: 'JetBrains Mono',  value: 'JetBrains Mono' },
  { label: 'Cascadia Code',   value: 'Cascadia Code' },
  { label: 'Fira Code',       value: 'Fira Code' },
  { label: 'Source Code Pro', value: 'Source Code Pro' },
  { label: 'Consolas',        value: 'Consolas' },
  { label: 'Menlo',           value: 'Menlo' },
]

export const FONT_WEIGHTS = [
  { id: 300 as const, label: 'Light' },
  { id: 400 as const, label: 'Regular' },
  { id: 500 as const, label: 'Medium' },
  { id: 600 as const, label: 'Semibold' },
]

export const BORDER_RADII = [
  { id: 'sharp'   as const, label: 'Sharp',   px: '2px',  shadcn: '0.125rem' },
  { id: 'default' as const, label: 'Default',  px: '6px',  shadcn: '0.375rem' },
  { id: 'rounded' as const, label: 'Rounded',  px: '10px', shadcn: '0.625rem' },
  { id: 'pill'    as const, label: 'Pill',     px: '16px', shadcn: '1rem' },
]

export const ACCENT_PRESETS = [
  '#e8622f', // orange
  '#4d9dff', // blue
  '#ff79c6', // pink
  '#cba6f7', // lavender
  '#4ade80', // green
  '#eb6f92', // rose
  '#a6e22e', // lime
  '#00d9c8', // cyan
  '#f9a825', // amber
  '#f97316', // bright orange
]

// ── Apply function ─────────────────────────────────────────────────────────────

export function applyAppearanceSettings(settings: Partial<AppSettings>): void {
  const root = document.documentElement

  // Theme
  const theme = THEMES.find(t => t.id === settings.theme) ?? THEMES[0]
  for (const [k, v] of Object.entries(theme.vars)) {
    root.style.setProperty(k, v)
  }

  // Accent override
  if (settings.accentColor) {
    root.style.setProperty('--lg-accent', settings.accentColor)
    root.style.setProperty('--lg-accent-hover', lightenHex(settings.accentColor, 0.12))
    root.style.setProperty('--lg-glow-accent',
      `0 0 18px ${hexToRgba(settings.accentColor, 0.25)}, 0 0 4px ${hexToRgba(settings.accentColor, 0.18)}`)
  }

  // --lg-accent-rgb exposes the RGB components for use in rgba() inline styles
  const finalAccent = settings.accentColor ?? theme.vars['--lg-accent']
  const [ar, ag, ab] = hexToRgbComponents(finalAccent)
  root.style.setProperty('--lg-accent-rgb', `${ar}, ${ag}, ${ab}`)

  // UI font
  const uiFont = settings.fontFamily ?? 'IBM Plex Sans'
  root.style.setProperty('--lg-font-ui', `'${uiFont}', system-ui, sans-serif`)

  // Code font
  const codeFont = settings.codeFontFamily ?? 'JetBrains Mono'
  root.style.setProperty('--lg-font-mono', `'${codeFont}', 'Cascadia Code', 'Fira Code', Consolas, monospace`)

  // Font size
  if (settings.fontSize) {
    root.style.setProperty('--lg-font-size', `${settings.fontSize}px`)
  }

  // Font weight
  if (settings.fontWeight) {
    root.style.setProperty('--lg-font-weight', String(settings.fontWeight))
  }

  // Border radius
  const r = BORDER_RADII.find(x => x.id === settings.borderRadius) ?? BORDER_RADII[1]
  root.style.setProperty('--lg-radius', r.px)
  root.style.setProperty('--radius', r.shadcn)

  // Density → row heights
  const rowH: Record<string, string> = { compact: '26px', normal: '32px', relaxed: '40px' }
  const padH: Record<string, string> = { compact: '3px', normal: '6px', relaxed: '10px' }
  root.style.setProperty('--lg-row-height', rowH[settings.uiDensity ?? 'normal'])
  root.style.setProperty('--lg-row-pad', padH[settings.uiDensity ?? 'normal'])
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function hexToRgbComponents(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)]
}

function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgbComponents(hex)
  return `rgba(${r},${g},${b},${alpha})`
}

function lightenHex(hex: string, amount: number): string {
  const clean = hex.replace('#', '')
  const r = Math.min(255, parseInt(clean.slice(0, 2), 16) + Math.round(255 * amount))
  const g = Math.min(255, parseInt(clean.slice(2, 4), 16) + Math.round(255 * amount))
  const b = Math.min(255, parseInt(clean.slice(4, 6), 16) + Math.round(255 * amount))
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

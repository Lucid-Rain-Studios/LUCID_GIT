/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // shadcn/ui compatibility tokens
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // ── Lucid Git design tokens ───────────────────────────────────────
        'lg-bg-primary':    '#0d0f15',
        'lg-bg-base':       '#0c0f17',
        'lg-bg-secondary':  '#131720',
        'lg-bg-overlay':    '#161c2b',
        'lg-bg-elevated':   '#1b2030',
        'lg-bg-hover':      '#ffffff0a',
        'lg-border':        '#1d2535',
        'lg-border-strong': '#283047',
        'lg-text-primary':  '#e2e6f4',
        'lg-text-secondary':'#7b8499',
        'lg-text-muted':    '#344057',
        'lg-accent':        '#e8622f',
        'lg-accent-blue':   '#4a9eff',
        'lg-success':       '#2dbd6e',
        'lg-warning':       '#f5a623',
        'lg-error':         '#e84040',
        'lg-purple':        '#a27ef0',
        'lg-lock-mine':     '#2dbd6e',
        'lg-lock-other':    '#e8622f',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['IBM Plex Sans', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Code', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}

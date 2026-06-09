/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './apps/desktop/src/renderer/index.html',
    './apps/web/index.html',
    './packages/app-core/src/**/*.{ts,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        // All colors resolve to CSS custom properties defined in index.css.
        // Values are space-separated RGB triplets so Tailwind's opacity
        // modifiers (e.g. `bg-paper-100/50`) keep working.
        paper: {
          50: 'rgb(var(--z-bg-softer) / <alpha-value>)',
          100: 'rgb(var(--z-bg) / <alpha-value>)',
          200: 'rgb(var(--z-bg-1) / <alpha-value>)',
          300: 'rgb(var(--z-bg-2) / <alpha-value>)',
          400: 'rgb(var(--z-bg-3) / <alpha-value>)',
          500: 'rgb(var(--z-bg-4) / <alpha-value>)'
        },
        ink: {
          900: 'rgb(var(--z-fg) / <alpha-value>)',
          800: 'rgb(var(--z-fg-1) / <alpha-value>)',
          700: 'rgb(var(--z-fg-2) / <alpha-value>)',
          600: 'rgb(var(--z-grey-2) / <alpha-value>)',
          500: 'rgb(var(--z-grey-1) / <alpha-value>)',
          400: 'rgb(var(--z-grey-0) / <alpha-value>)',
          300: 'rgb(var(--z-grey-dim) / <alpha-value>)'
        },
        accent: {
          DEFAULT: 'rgb(var(--z-accent) / <alpha-value>)',
          soft: 'rgb(var(--z-accent-soft) / <alpha-value>)',
          muted: 'rgb(var(--z-accent-muted) / <alpha-value>)'
        },
        // Themed semantic colors — follow the active theme via the same
        // CSS custom properties, so danger/success/warning are no longer
        // hardcoded to Tailwind's static red/green/yellow.
        danger: 'rgb(var(--z-red) / <alpha-value>)',
        success: 'rgb(var(--z-green) / <alpha-value>)',
        warning: 'rgb(var(--z-yellow) / <alpha-value>)'
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"Inter"',
          'system-ui',
          'sans-serif'
        ],
        serif: [
          '"Iowan Old Style"',
          '"Source Serif Pro"',
          'Georgia',
          'serif'
        ],
        mono: [
          '"JetBrains Mono"',
          '"SF Mono"',
          'Menlo',
          'monospace'
        ]
      },
      boxShadow: {
        panel:
          '0 1px 0 0 rgb(var(--z-shadow) / 0.04), 0 8px 28px -12px rgb(var(--z-shadow) / 0.18)',
        float: '0 20px 60px -20px rgb(var(--z-shadow) / 0.28)'
      },
      // Type scale. Tailwind's built-in steps (xs=12, sm=14, base=16, lg=18,
      // xl=20, 2xl=24, 3xl=30) are kept; we add an 11px floor for genuinely
      // secondary micro-text (uppercase labels, key hints, dense grids).
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }]
      },
      // Documented elevation scale — replaces ad-hoc z-[50/70/72/74].
      zIndex: {
        dropdown: '40',
        palette: '50',
        modal: '70',
        nested: '75',
        popover: '80',
        toast: '90'
      },
      // Dialog width scale — Modal maps its `size` prop onto these.
      maxWidth: {
        'dialog-xs': '420px',
        'dialog-sm': '440px',
        'dialog-md': '560px',
        'dialog-lg': '720px',
        'dialog-xl': '900px',
        'dialog-2xl': '1120px',
        'dialog-3xl': '1360px'
      }
    }
  },
  plugins: []
}

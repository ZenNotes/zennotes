/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', '../../packages/app-core/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
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
        }
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
        serif: ['"Iowan Old Style"', '"Source Serif Pro"', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', '"SF Mono"', 'Menlo', 'monospace']
      },
      boxShadow: {
        panel:
          '0 1px 0 0 rgb(var(--z-shadow) / 0.04), 0 8px 28px -12px rgb(var(--z-shadow) / 0.18)',
        float: '0 20px 60px -20px rgb(var(--z-shadow) / 0.28)'
      }
    }
  },
  plugins: []
}

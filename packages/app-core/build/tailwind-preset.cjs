/** @type {import('tailwindcss').Config} */
module.exports = {
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
        },
        danger: 'rgb(var(--z-red) / <alpha-value>)',
        success: 'rgb(var(--z-green) / <alpha-value>)',
        warning: 'rgb(var(--z-yellow) / <alpha-value>)'
      },
      borderRadius: {
        // Scale every rounded-* by --z-radius-scale (default 1) so one var can
        // square all corners (Quick tweaks → Square corners sets it to 0).
        // rounded-none / rounded-full keep Tailwind defaults, so pills and
        // circles stay round.
        DEFAULT: 'calc(0.25rem * var(--z-radius-scale, 1))',
        sm: 'calc(0.125rem * var(--z-radius-scale, 1))',
        md: 'calc(0.375rem * var(--z-radius-scale, 1))',
        lg: 'calc(0.5rem * var(--z-radius-scale, 1))',
        xl: 'calc(0.75rem * var(--z-radius-scale, 1))',
        '2xl': 'calc(1rem * var(--z-radius-scale, 1))',
        '3xl': 'calc(1.5rem * var(--z-radius-scale, 1))'
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
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }]
      },
      zIndex: {
        dropdown: '40',
        palette: '50',
        modal: '70',
        nested: '75',
        popover: '80',
        toast: '90'
      },
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

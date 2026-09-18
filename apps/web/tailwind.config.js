import preset from '../../packages/app-core/build/tailwind-preset.cjs'

/** @type {import('tailwindcss').Config} */
export default {
  presets: [preset],
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/app-core/src/**/*.{ts,tsx}']
}

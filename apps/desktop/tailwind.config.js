/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [require('../../packages/app-core/build/tailwind-preset.cjs')],
  content: ['./src/renderer/index.html', '../../packages/app-core/src/**/*.{ts,tsx}']
}

/**
 * Preloaded into a smoke test's Electron main process (`NODE_OPTIONS=--require`)
 * so the test window never takes the keyboard.
 *
 * Shown the usual way, the window becomes the OS key window, and every key
 * typed or posted on the machine during the run lands in the test editor: a
 * person typing in another app, or another agent's synthetic keystrokes. Vim
 * then reads a stray `1` or `t` between the suite's own keys, `8j` becomes
 * `18j` or `8tj`, and a motion check fails on a busy machine and passes on a
 * quiet one. Shown inactive and never focused, the window leaves the keyboard
 * where it was; the suite drives it over CDP, which needs no OS focus, and
 * turns on CDP focus emulation so the page still behaves as focused.
 *
 * `electron` is not resolvable yet while preloads run, so the patch waits a
 * tick. Child processes inherit NODE_OPTIONS too; only the main process
 * patches.
 */
setImmediate(() => {
  if (process.type !== 'browser') return
  const { BrowserWindow, app } = require('electron')
  BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive
  BrowserWindow.prototype.focus = function focus() {}
  app.focus = () => {}
})

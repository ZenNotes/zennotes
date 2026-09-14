ZenNotes 2.50.2: dismiss update notifications

> Update notifications now have a close button, so you can clear the toast and keep writing.

## 🐛 Fixes

- **Dismiss the update toast.** Use the × button to close an available-update, download-progress, or ready-to-relaunch notification. The button is keyboard accessible and follows your theme.
- **Dismissed notices stay quiet.** Repeated notifications and download progress updates do not bring the same notice back. A new version or a different update phase can show a fresh notice. Restarting the app can show the notice again.
- **Update when you are ready.** Dismissing the toast leaves the update controls in Settings available and does not cancel a download.

## 🧰 For contributors

- Reuses the shared icon button and close icon. Dismissal tracks the update version and phase in local UI state.
- All eight package versions and lockfile metadata are aligned at 2.50.2; dependencies are unchanged.
- Local validation: the full production build and all seven typecheck tasks passed; 4,391 JavaScript tests passed with five skipped, and the Go tests passed. The production dependency audit reported no vulnerabilities. The dismiss button was previewed in the macOS desktop app.

---

Local-first and keyboard-first, as always.

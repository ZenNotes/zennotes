# ZenNotes Mobile — Specification Set

This directory specifies the ZenNotes mobile apps (iOS first, Android fast-follow) and the first-party sync service that ships alongside them.

These are **planning specs**, not documentation of shipped behavior. Nothing here is implemented yet. When a spec is realized, its user-facing parts should move into `docs/tutorials`, `docs/how-to`, and `docs/reference` per the Diátaxis model described in [`docs/README.md`](../../README.md).

## Foundational decisions

These four decisions are settled and every spec assumes them:

| Decision | Choice | Why |
|---|---|---|
| **Tech stack** | **Capacitor** (WebView shell over `packages/app-core`) | ~100% reuse of the existing React UI, CodeMirror 6 editor, and KaTeX/Mermaid/plot renderers. Same architecture Obsidian uses. |
| **Storage & sync** | **Local-first vault + first-party ZenNotes Sync** (E2E) | Offline-first is non-negotiable for a mobile notes app; owning the sync layer avoids the data-loss class of bugs that plague Obsidian mobile. |
| **Platforms** | **iOS first, Android fast-follow** | Validate the shell + bridge + sync on one platform (macOS/Xcode tooling is ready) before doubling QA surface. |
| **v1 UX** | **Capture + read + light edit** | Mobile-first flow, not the desktop IA crammed onto a phone. The full editor is available but the UX is optimized for fast capture and high-fidelity reading. |

## Reading order

1. [01 — Overview & Product Goals](./01-overview.md) — vision, users, goals/non-goals, success metrics
2. [02 — Architecture](./02-architecture.md) — Capacitor shell, `apps/mobile`, the third `ZenBridge`, reuse map, build/CI
3. [03 — Storage & Vault](./03-storage-and-vault.md) — on-device vault, iOS/Android file access, indexing, attachments
4. [04 — Sync Engine](./04-sync-engine.md) — first-party ZenNotes Sync: protocol, E2E crypto, conflict resolution
5. [05 — Rendering & Content](./05-rendering-and-content.md) — KaTeX, Mermaid, plots, images, PDF, and the TikZ decision
6. [06 — Editor & Input](./06-editor-and-input.md) — CodeMirror on touch, mobile toolbar, keyboard/IME, gestures
7. [07 — Navigation & UX](./07-navigation-and-ux.md) — small-screen IA, drawers, bottom nav, quick capture, iPad
8. [08 — Distribution & Release](./08-distribution-and-release.md) — App Store / Play Store, entitlements, permissions, CI/CD
9. [09 — Roadmap & Risks](./09-roadmap-and-risks.md) — phased plan, milestones, risks, open questions

## How the mobile app fits the monorepo

ZenNotes already runs three product modes over one product core (`packages/app-core`) and one typed host contract (`packages/bridge-contract`). Mobile is the **fourth runtime**, added the same way the others were:

```text
apps/desktop  → Electron shell   + Electron/IPC bridge   (runtime: 'desktop')
apps/web      → Vite/PWA shell   + HTTP bridge → Go server (runtime: 'web')
ZenNotes/znserver (separate repository) → Go backend
apps/mobile   → Capacitor shell  + native bridge          (runtime: 'mobile')   ← NEW
packages/app-core        → shared React UI + renderers (reused verbatim)
packages/bridge-contract → the ZenBridge seam (extended with a 'mobile' runtime + capability flags)
```

See [`docs/monorepo-architecture.md`](../../monorepo-architecture.md) and [`docs/reference/runtime-and-package-map.md`](../../reference/runtime-and-package-map.md) for the existing runtime model these specs build on.

## Sources

The Obsidian-mobile analysis these specs draw on (Capacitor architecture, mobile storage/sync constraints, plugin limits, and the data-loss pitfalls we design around) is summarized inline where relevant, with links to `help.obsidian.md`, `docs.obsidian.md`, and the Obsidian forum.

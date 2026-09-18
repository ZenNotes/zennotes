# Contributing to ZenNotes

Thanks for your interest in improving ZenNotes — a keyboard-first, Markdown-first
desktop notes app built on Electron, React, TypeScript, and CodeMirror 6.

## Before you start

- For **anything non-trivial**, open an issue first so we can agree on scope
  and approach before you spend time building.
- For **small fixes** (typos, obvious bugs, dependency bumps), open a PR
  directly.
- For **security issues**, do not open a public issue — follow
  [SECURITY.md](./SECURITY.md).

## Getting set up

```bash
git clone https://github.com/ZenNotes/zennotes.git
cd zennotes
npm install
npm run dev
```

Useful scripts:

- `npm run dev` — run the desktop app with hot reload (`dev:web`, `dev:server`, and `dev:web-stack` cover the web client and the pinned Go server release)
- `npm run typecheck` — TypeScript across every workspace
- `npm run test:run` — the full test suite, non-interactive (`npm test` is the watch variant)
- `npm run build` — production build of the web client and desktop app
- The Go server and its tests live in [ZenNotes/znserver](https://github.com/ZenNotes/znserver)

There is no lint step; match the style of the surrounding code (Prettier is available
if a file you touched is already formatted with it).

## Working on a change

1. Fork the repo and create a feature branch from `main`.
2. Keep commits focused. A clear commit message beats a long PR description.
3. Add or update tests when you change behavior.
4. Make sure `npm run typecheck`, `npm run test:run`, and `npm run build` pass locally.
5. Open a pull request against `main`.

## Pull request requirements

Branch protection on `main` enforces:

- **Pull request required** — no direct pushes
- **One approving review from a code owner** (see
  [.github/CODEOWNERS](./.github/CODEOWNERS))
- **Green CI** across Linux, macOS, and Windows build jobs
- **Linear history** (squash merge only; the head branch is auto-deleted)
- **All review comments resolved** before merging

## Style and scope

- Match the style of the surrounding code — don't introduce new patterns
  mid-file.
- Keep the scope of each PR tight. Refactors, feature work, and formatting
  changes belong in separate PRs.
- ZenNotes is keyboard-first. Every new user-facing feature should ship with a
  keybinding or leader flow.

## Code of conduct

Be kind, assume good faith, focus on the work.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).

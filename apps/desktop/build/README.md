# App icon resources

electron-builder looks here for the app icon when packaging.

Drop the enso icon as `icon.png` (ideally 1024×1024) in this folder:

```
build/icon.png
```

electron-builder will auto-generate the macOS `.icns`, Windows `.ico`,
and Linux icon sizes from that single source.

If you want per-platform overrides:

- `build/icon.icns` — macOS
- `build/icon.ico` — Windows
- `build/icons/*.png` — Linux (multiple sizes)

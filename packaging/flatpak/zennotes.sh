#!/bin/sh
# Wrap the Electron binary with zypak so Chromium's sandbox works inside the
# Flatpak sandbox (the SUID chrome-sandbox is unavailable here).
exec zypak-wrapper /app/zennotes/ZenNotes "$@"

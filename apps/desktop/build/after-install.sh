#!/bin/sh

set -eu

SANDBOX_PATH="/opt/ZenNotes/chrome-sandbox"

# Debian installs under /opt/ZenNotes, where Electron's helper needs
# root ownership plus the setuid bit on systems that still require the
# chrome-sandbox path. If the layout ever changes, skip cleanly rather
# than failing the whole package install or upgrade.
if [ ! -f "$SANDBOX_PATH" ]; then
  exit 0
fi

chown root:root "$SANDBOX_PATH"
chmod 4755 "$SANDBOX_PATH"

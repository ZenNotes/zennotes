#!/usr/bin/env bash
#
# Update Casks/zennotes.rb to a published release.
#
# Pins `version` and both arm64/x64 SHA-256s straight from the GitHub release
# assets — no large downloads, the checksums come from the API `digest` field.
#
# Usage:
#   packaging/homebrew/update-cask.sh 2.5.0
#
# Then copy Casks/zennotes.rb into the ZenNotes/homebrew-tap repo (see README).
# Requires: gh (authenticated), shasum is not needed (digests come from GitHub).

set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "usage: $0 <version>   e.g. $0 2.5.0" >&2
  exit 1
fi
VERSION="${VERSION#v}" # tolerate a leading v

REPO="ZenNotes/zennotes"
CASK="$(cd "$(dirname "$0")" && pwd)/Casks/zennotes.rb"

digest_for() { # $1 = arch suffix (arm64|x64)
  gh api "repos/${REPO}/releases/tags/v${VERSION}" \
    --jq ".assets[] | select(.name==\"ZenNotes-${VERSION}-mac-$1.dmg\") | .digest" \
    | sed 's/^sha256://'
}

echo "Fetching digests for v${VERSION} from ${REPO}…"
ARM_SHA="$(digest_for arm64)"
X64_SHA="$(digest_for x64)"

if [[ -z "$ARM_SHA" || -z "$X64_SHA" ]]; then
  echo "error: could not find both mac DMG assets for v${VERSION}." >&2
  echo "       Make sure the release exists and the assets finished uploading." >&2
  exit 1
fi

echo "  arm64: $ARM_SHA"
echo "  x64:   $X64_SHA"

# Rewrite version + both checksums in place.
/usr/bin/sed -i '' \
  -e "s/^  version \".*\"/  version \"${VERSION}\"/" \
  -e "s/^  sha256 arm:   \".*\",/  sha256 arm:   \"${ARM_SHA}\",/" \
  -e "s/^         intel: \".*\"/         intel: \"${X64_SHA}\"/" \
  "$CASK"

echo "Updated $CASK -> v${VERSION}"
echo "Next: copy it into the tap and push (see packaging/homebrew/README.md)."

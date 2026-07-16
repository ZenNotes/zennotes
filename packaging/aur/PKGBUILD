# Maintainer: Adib Hanna <adibhanna@gmail.com>
#
# AUR package for ZenNotes (yay -S zennotes-bin).
#
# Before publishing a new version:
#   1. bump pkgver to match the GitHub release tag (without the leading "v"),
#   2. run `updpkgsums` to fill in sha256sums (or `makepkg -g`),
#   3. regenerate .SRCINFO: `makepkg --printsrcinfo > .SRCINFO`,
#   4. test with `makepkg -si` on an Arch/CachyOS box.

pkgname=zennotes-bin
_appname=ZenNotes
pkgver=2.13.4
pkgrel=1
pkgdesc="Keyboard-first, local-first Markdown notes with vim motions and live preview"
arch=('x86_64')
url="https://github.com/ZenNotes/zennotes"
license=('MIT')
depends=('gtk3' 'nss' 'alsa-lib' 'libxss')
provides=('zennotes')
conflicts=('zennotes')
options=('!strip')

source=(
  "${_appname}-${pkgver}-linux-x64.tar.gz::${url}/releases/download/v${pkgver}/${_appname}-${pkgver}-linux-x64.tar.gz"
)

# sha256 of the uploaded ZenNotes-${pkgver}-linux-x64.tar.gz release asset
# (GitHub's authoritative asset digest; no Arch tooling needed).
sha256sums=('3a3ac12e2ebd09b14c1b114e8f81299858b65d3599a2ed4224e56685a0ed4dc8')

package() {
  cd "${srcdir}"

  local _extracted="${_appname}-${pkgver}-linux-x64"
  local _extras="${_extracted}/resources/arch-extras"

  # Install application
  install -dm755 "${pkgdir}/opt/${pkgname}"
  # tar.gz preserves permissions (unlike squashfs extraction)
  # chmod workarounds from #70/#74/#92 are no longer needed.
  cp -a "${_extracted}/." "${pkgdir}/opt/${pkgname}/"

  # Chromium sandbox
  if [[ -f "${pkgdir}/opt/${pkgname}/chrome-sandbox" ]]; then
    chmod 4755 "${pkgdir}/opt/${pkgname}/chrome-sandbox"
  fi

  # CLI launcher
  install -dm755 "${pkgdir}/usr/bin"
  ln -s "/opt/${pkgname}/${_appname}" "${pkgdir}/usr/bin/zennotes"

  # Desktop entry
  if [[ -f "${_extras}/zennotes.desktop" ]]; then
    install -Dm644 \
      "${_extras}/zennotes.desktop" \
      "${pkgdir}/usr/share/applications/zennotes.desktop"
  fi

  # Icons
  local size
  for size in 16 24 32 48 64 128 256 512; do
    if [[ -f "${_extras}/icons/${size}x${size}.png" ]]; then
      install -Dm644 \
        "${_extras}/icons/${size}x${size}.png" \
        "${pkgdir}/usr/share/icons/hicolor/${size}x${size}/apps/zennotes.png"
    fi
  done

  # LICENSE
  install -Dm644 \
    "${_extracted}/LICENSE" \
    "${pkgdir}/usr/share/licenses/${pkgname}/LICENSE"
}

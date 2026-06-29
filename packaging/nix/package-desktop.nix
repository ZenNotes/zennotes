{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
  makeWrapper,
  wrapGAppsHook3,
  copyDesktopItems,
  makeDesktopItem,

  # Electron / Chromium runtime libraries
  alsa-lib,
  at-spi2-atk,
  at-spi2-core,
  atk,
  cairo,
  cups,
  dbus,
  expat,
  fontconfig,
  freetype,
  gdk-pixbuf,
  glib,
  gtk3,
  libdrm,
  libGL,
  libgbm,
  libnotify,
  libpulseaudio,
  libuuid,
  libxkbcommon,
  nspr,
  nss,
  pango,
  systemd,
  wayland,
  xorg,

  commandLineArgs ? "",
}:
let
  releaseData = lib.importJSON ./release-data.json;
in
# Packaged from the official prebuilt linux-x64 release tarball rather than built
# from source, so `nix run github:ZenNotes/zennotes` downloads the same signed
# binary the AppImage/deb/AUR ship instead of compiling Electron locally. Bump
# `version` + `desktopHash` in release-data.json per release (see README.md).
stdenv.mkDerivation (finalAttrs: {
  pname = "zennotes-desktop";
  inherit (releaseData) version;

  src = fetchurl {
    url = "https://github.com/ZenNotes/zennotes/releases/download/v${finalAttrs.version}/ZenNotes-${finalAttrs.version}-linux-x64.tar.gz";
    hash = releaseData.desktopHash;
  };

  sourceRoot = "ZenNotes-${finalAttrs.version}-linux-x64";

  nativeBuildInputs = [
    autoPatchelfHook
    makeWrapper
    wrapGAppsHook3
    copyDesktopItems
  ];

  buildInputs = [
    alsa-lib
    at-spi2-atk
    at-spi2-core
    atk
    cairo
    cups
    dbus
    expat
    fontconfig
    freetype
    gdk-pixbuf
    glib
    gtk3
    libdrm
    libgbm
    libuuid
    libxkbcommon
    nspr
    nss
    pango
    stdenv.cc.cc # libstdc++
    xorg.libX11
    xorg.libXcomposite
    xorg.libXcursor
    xorg.libXdamage
    xorg.libXext
    xorg.libXfixes
    xorg.libXi
    xorg.libXrandr
    xorg.libXrender
    xorg.libXScrnSaver
    xorg.libXtst
    xorg.libxcb
  ];

  # dlopen'd at runtime (not in DT_NEEDED), so keep them on the wrapper's path.
  runtimeDependencies = [
    (lib.getLib systemd)
    libGL
    libnotify
    libpulseaudio
    wayland
  ];

  dontConfigure = true;
  dontBuild = true;
  # We invoke makeWrapper manually and splice in gappsWrapperArgs ourselves.
  dontWrapGApps = true;

  installPhase = ''
    runHook preInstall

    # The SUID chrome-sandbox can't be made setuid in the Nix store; drop it so
    # Electron falls back to the user-namespace sandbox (same as the Flatpak).
    rm -f chrome-sandbox

    mkdir -p $out/share/zennotes
    cp -r . $out/share/zennotes

    # Icons + desktop entry ship inside the tarball's arch-extras tree.
    for icon in $out/share/zennotes/resources/arch-extras/icons/*.png; do
      size="$(basename "$icon" .png)"
      install -Dm644 "$icon" "$out/share/icons/hicolor/$size/apps/${finalAttrs.pname}.png"
    done

    makeWrapper $out/share/zennotes/ZenNotes $out/bin/${finalAttrs.pname} \
      "''${gappsWrapperArgs[@]}" \
      --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto}}" \
      ${lib.optionalString (commandLineArgs != "") "--add-flags ${lib.escapeShellArg commandLineArgs}"}

    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      name = finalAttrs.pname;
      desktopName = "ZenNotes";
      exec = "${finalAttrs.pname} %U";
      icon = finalAttrs.pname;
      comment = "Keyboard-first local Markdown notes";
      categories = [
        "Office"
        "Utility"
        "TextEditor"
      ];
      startupWMClass = "ZenNotes";
      mimeTypes = [
        "text/markdown"
        "x-scheme-handler/zennotes"
      ];
    })
  ];

  meta = {
    description = "Keyboard-first local Markdown notes with Vim motions, diagrams, and MCP integration (prebuilt binary)";
    homepage = "https://zennotes.org/";
    changelog = "https://github.com/ZenNotes/zennotes/releases/tag/v${finalAttrs.version}";
    license = lib.licenses.mit;
    maintainers = with lib.maintainers; [ justkrysteq ];
    mainProgram = finalAttrs.pname;
    sourceProvenance = with lib.sourceTypes; [ binaryNativeCode ];
    platforms = [ "x86_64-linux" ];
  };
})

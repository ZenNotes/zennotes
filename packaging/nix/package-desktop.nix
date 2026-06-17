{
  stdenv,
  lib,
  buildNpmPackage,
  fetchFromGitHub,
  makeDesktopItem,
  copyDesktopItems,
  electron,
  makeWrapper,

  installCLI ? false,
  CLIcommand ? "zen",
  commandLineArgs ? "",
}:
let
  releaseData = lib.importJSON ./release-data.json;
in
buildNpmPackage (finalAttrs: {
  pname = "zennotes-desktop";
  inherit (releaseData) version npmDepsHash;

  src = fetchFromGitHub {
    owner = "ZenNotes";
    repo = "zennotes";
    tag = "v${finalAttrs.version}";
    inherit (releaseData) hash;
  };

  npmWorkspace = "apps/desktop";

  env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

  nativeBuildInputs = [
    makeWrapper
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [
    copyDesktopItems
  ];

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/node_modules/zennotes-monorepo
    cp -r . $out/lib/node_modules/zennotes-monorepo/

    for icon in apps/desktop/build/icons/*.png; do
      size="$(basename "$icon" .png)"
      install -Dm644 $icon $out/share/icons/hicolor/$size/apps/${finalAttrs.pname}.png
    done

    mkdir -p $out/bin
    makeWrapper ${electron}/bin/electron $out/bin/${finalAttrs.pname} \
      --add-flags "$out/lib/node_modules/zennotes-monorepo/apps/desktop" \
      --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto}}" \
      ${lib.optionalString (commandLineArgs != "") "--add-flags ${lib.escapeShellArg commandLineArgs}"}

    ${lib.optionalString installCLI ''
      makeWrapper ${electron}/libexec/electron/electron $out/bin/${CLIcommand} \
        --set ELECTRON_RUN_AS_NODE 1 \
        --add-flags "$out/lib/node_modules/zennotes-monorepo/apps/desktop/out/main/cli.js"
    ''}

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
    description = "Keyboard-first local Markdown notes with Vim motions, diagrams, and MCP integration";
    homepage = "https://zennotes.org/";
    changelog = "https://github.com/ZenNotes/zennotes/releases/tag/v${finalAttrs.version}";
    license = lib.licenses.mit;
    maintainers = with lib.maintainers; [ justkrysteq ];
    mainProgram = finalAttrs.pname;
    inherit (electron.meta) platforms;
  };
})

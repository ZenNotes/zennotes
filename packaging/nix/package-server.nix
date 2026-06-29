{
  lib,
  buildGoModule,
  fetchFromGitHub,
  buildNpmPackage,
}:
let
  releaseData = lib.importJSON ./release-data.json;

  src = fetchFromGitHub {
    owner = "ZenNotes";
    repo = "zennotes";
    tag = "v${releaseData.version}";
    inherit (releaseData) hash;
  };

  web = buildNpmPackage {
    pname = "zennotes-web";

    inherit (releaseData) version npmDepsHash;
    inherit src;

    npmWorkspace = "apps/web";

    env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

    installPhase = ''
      runHook preInstall

      mkdir -p "$out"
      cp -R apps/web/dist/. "$out/"

      runHook postInstall
    '';
  };
in
buildGoModule (finalAttrs: {
  pname = "zennotes-server";

  inherit (releaseData) version vendorHash;
  inherit src;

  modRoot = "apps/server";

  subPackages = [ "cmd/zennotes-server" ];
  ldflags = [
    "-s"
    "-w"
  ];

  preBuild = ''
    rm -rf web/dist
    mkdir -p web/dist
    cp -R ${web}/. web/dist/
  '';

  meta = {
    description = "A server API for hosting remote ZenNotes vaults";
    homepage = "https://zennotes.org/";
    changelog = "https://github.com/ZenNotes/zennotes/releases/tag/v${finalAttrs.version}";
    license = lib.licenses.mit;
    maintainers = with lib.maintainers; [ justkrysteq ];
    mainProgram = finalAttrs.pname;
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
})

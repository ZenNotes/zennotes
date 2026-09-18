{
  description = "ZenNotes - Keyboard-first local Markdown notes";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { nixpkgs, ... }:
    let
      systems = nixpkgs.lib.platforms.linux ++ nixpkgs.lib.platforms.darwin;

      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      # The desktop package wraps the prebuilt linux-x64 release tarball, so it
      # only exists on x86_64-linux. The self-hosted server is packaged in its
      # own repository, ZenNotes/znserver.
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        if system == "x86_64-linux" then
          let
            zennotes-desktop = pkgs.callPackage ./packaging/nix/package-desktop.nix { };
          in
          {
            inherit zennotes-desktop;
            default = zennotes-desktop;
          }
        else
          { }
      );

      devShell = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs
            electron
            turbo
          ];

          shellHook = ''
            export ELECTRON_SKIP_BINARY_DOWNLOAD=1
          '';
        }
      );
    };
}

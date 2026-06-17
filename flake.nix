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
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        rec {
          zennotes-desktop = pkgs.callPackage ./packaging/nix/package-desktop.nix { };

          zennotes-server = pkgs.callPackage ./packaging/nix/package-server.nix { };

          default = zennotes-desktop;
        }
      );

      devShell = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        pkgs.mkShell {
          buildInputs = with pkgs; [
            go
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

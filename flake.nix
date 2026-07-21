{
  description = "ZenNotes - Keyboard-first local Markdown notes";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = {nixpkgs, ...}: let
    systems = nixpkgs.lib.platforms.linux ++ nixpkgs.lib.platforms.darwin;

    forAllSystems = nixpkgs.lib.genAttrs systems;
  in {
    packages = forAllSystems (
      system: let
        pkgs = nixpkgs.legacyPackages.${system};
        zennotes-server = pkgs.callPackage ./packaging/nix/package-server.nix {};
      in
        {inherit zennotes-server;}
        # The desktop package wraps the prebuilt linux-x64 release tarball, so it
        # only exists on x86_64-linux; elsewhere the server is the default.
        // (
          if system == "x86_64-linux"
          then let
            zennotes-desktop = pkgs.callPackage ./packaging/nix/package-desktop.nix {};
          in {
            inherit zennotes-desktop;
            default = zennotes-desktop;
          }
          else {default = zennotes-server;}
        )
    );

    devShell = forAllSystems (
      system: let
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
    nixosModules = {
      server = import ./packaging/nix/server-module.nix;
    };
  };
}

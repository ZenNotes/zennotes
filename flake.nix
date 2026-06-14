{
  description = "ZenNotes - Local-first Markdown Notes App";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = {
    self,
    nixpkgs,
  }: let
    # Für dieses Beispiel hardcoden wir auf Linux.
    # Für Multi-Platform (MacOS/Linux) nutzt man meist flake-utils.
    system = "x86_64-linux";
    pkgs = import nixpkgs {inherit system;};
    version = "2.3.0";

    frontend-web = pkgs.buildNpmPackage {
      pname = "zennotes-web";
      version = "${version}";
      # whole repo as part, because of turbo, building with workspace param
      src = ./.;
      npmDepsHash = "sha256-7IpGnxVjaJvfSZyKjOylGMhFqa1bx8Ry5O1yqYfNnCE=";

      # we use the nix electon here and dont want NPM to donwload it
      ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

      buildPhase = ''
        echo "building the web frontend..."
        npm run build --workspace=apps/web
      '';

      #copy the built web frontend to package it with the backend, needed by go:embed
      installPhase = ''
        mkdir -p $out/share/zennotes-web
        cp -r apps/web/dist/* $out/share/zennotes-web/
      '';
    };
    backend = pkgs.buildGoModule {
      pname = "zennotes-server";
      version = "${version}";

      src = ./apps/server;

      vendorHash = "sha256-wYBF7CjM6AvoWMWql9hFmIaj6pCmli4vOef6POyGkfU=";

      preBuild = ''
        mkdir -p web/dist
        cp -r ${frontend-web}/share/zennotes-web/* web/dist/
      '';
    };

    frontend-desktop = pkgs.buildNpmPackage {
      pname = "zennotes-frontend-desktop";
      version = "${version}";

      # whole repo as src, see fronten-web part
      src = ./.;

      npmDepsHash = "sha256-7IpGnxVjaJvfSZyKjOylGMhFqa1bx8Ry5O1yqYfNnCE=";

      # we use the nix electon here and dont want NPM to donwload it
      ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

      buildPhase = ''
        echo "Start turborepo build for desktop..."
        npm run build --workspace=apps/desktop
      '';

      # copy the compiled files and node_modules for dependencies
      installPhase = ''
        mkdir -p $out/share/zennotes
        cp -r apps/desktop/out/* $out/share/zennotes/
        cp -r -L node_modules $out/share/zennotes/
      '';
      postFixup = ''
        # allow nix store inside the index.js file

        sed -i '/function isTrustedRendererUrl/a \  if (url.includes("nix/store")) return true;' \
          $out/share/zennotes/main/index.js
      '';
    };
  in {
    packages.${system} = {
      default = pkgs.stdenv.mkDerivation {
        pname = "zennotes";
        version = "${version}";

        # wo only combine here
        dontUnpack = true;

        nativeBuildInputs = [pkgs.makeWrapper];

        installPhase = ''
              mkdir -p $out/bin
               mkdir -p $out/share/zennotes

            # copy the frontend  files into the final path
               cp -r ${frontend-desktop}/share/zennotes/* $out/share/zennotes/

          # wrap application with electron
               makeWrapper ${pkgs.electron}/bin/electron $out/bin/zennotes \
                 --add-flags "$out/share/zennotes/main/index.js" \
                 --set NODE_PATH "$out/share/zennotes/node_modules" \
                 --prefix PATH : ${pkgs.lib.makeBinPath [backend]}
        '';
      };

      # server only for selfhosting
      server = backend;
    };

    devShells.${system}.default = pkgs.mkShell {
      buildInputs = with pkgs; [
        nodejs_22
        go_1_22
        electron
        turbo
      ];

      shellHook = ''
        export ELECTRON_SKIP_BINARY_DOWNLOAD=1
        echo "ZenNotes Dev Environment loaded - using the nix electron, skipping npm download!"
      '';
    };
  };
}

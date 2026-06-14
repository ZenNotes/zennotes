{
  description = "ZenNotes - Local-first Markdown Notes App";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = nixpkgs.legacyPackages.${system};
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
      packages = {
        default = pkgs.stdenv.mkDerivation {
          pname = "zennotes";
          version = "${version}";

          # wo only combine here
          dontUnpack = true;

          desktopItems = [
            (pkgs.makeDesktopItem {
              name = "zennotes";
              exec = "zennotes"; # This calls the binary wrapper we made in $out/bin
              icon = "zennotes"; # The system looks for an icon named 'zennotes'
              desktopName = "ZenNotes";
              genericName = "Note-Taking App";
              comment = "An elegant, sandboxed markdown note-taking app";
              categories = ["Office" "Utility" "TextEditor"];
            })
          ];

          nativeBuildInputs = with pkgs; [
            makeWrapper
            copyDesktopItems
          ];

          installPhase =
            if pkgs.stdenv.hostPlatform.isDarwin
            then ''
              APP_DIR="$out/Applications/ZenNotes.app/Contents"
              mkdir -p "$APP_DIR/MacOS"
              mkdir -p "$APP_DIR/Resources"

              cp -r ${frontend-desktop}/share/zennotes/* "$APP_DIR/Resources/"

              makeWrapper ${pkgs.electron}/Applications/Electron.app/Contents/MacOS/Electron "$APP_DIR/MacOS/ZenNotes" \
                --add-flags "$APP_DIR/Resources/main/index.js" \
                --set NODE_PATH "$APP_DIR/Resources/node_modules" \
                --prefix PATH : ${pkgs.lib.makeBinPath [backend]}

              # 3. CLI-Link fürs Terminal
              mkdir -p $out/bin
              ln -s "$APP_DIR/MacOS/ZenNotes" $out/bin/zennotes
            ''
            else ''
              mkdir -p $out/bin
              mkdir -p $out/share/zennotes

              # copy the frontend  files into the final path
              cp -r ${frontend-desktop}/share/zennotes/* $out/share/zennotes/

              # wrap application with electron
              makeWrapper ${pkgs.electron}/bin/electron $out/bin/zennotes \
                --add-flags "$out/share/zennotes/main/index.js" \
                --set NODE_PATH "$out/share/zennotes/node_modules" \
                --prefix PATH : ${pkgs.lib.makeBinPath [backend]}

              if [ -d "apps/desktop/resources/icons" ]; then
                mkdir -p $out/share/icons/hicolor/512x512/apps
                # Adjust this path depending on where your actual app icon sits in your source
                cp apps/desktop/resources/icon.png $out/share/icons/hicolor/512x512/apps/zennotes.png
              fi
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
    });
}

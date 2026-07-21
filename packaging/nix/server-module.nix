{
  config,
  lib,
  pkgs,
  ...
}:
with lib; let
  cfg = config.services.zennotes;
in {
  options.services.zennotes = {
    enable = mkEnableOption "ZenNotes self-hosted server";

    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ./package-server.nix {};
      description = "The zennotes server package to use.";
    };

    dataDir = mkOption {
      type = types.str;
      default = "/var/lib/zennotes";
      description = "Directory to store server data and auth tokens.";
    };

    vaultPath = mkOption {
      type = types.str;
      default = "/var/lib/zennotes/vault";
      description = "Path to the markdown vault directory.";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to open the port in the firewall.";
    };

    port = mkOption {
      type = types.port;
      default = 7878;
      description = "Port the ZenNotes server listens on.";
    };

    bindAddress = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = "Address the server binds to.";
    };

    extraEnvironment = mkOption {
      type = types.attrsOf types.str;
      default = {};
      description = "Extra environment variables for the ZenNotes server.";
    };

    settings = mkOption {
      type = types.submodule {
        freeformType = (pkgs.formats.toml {}).type;
      };
      default = {};
      description = ''
        Declarative settings for ZenNotes. Translated directly into config.toml.
      '';
    };
  };

  config = mkIf cfg.enable (
    let
      configFile = (pkgs.formats.toml {}).generate "config.toml" cfg.settings;
    in {
      # Ensure state directories exist with proper permissions
      systemd.tmpfiles.rules = [
        "d '${cfg.dataDir}' 0750 zennotes zennotes -"
        "d '${cfg.vaultPath}' 0770 zennotes zennotes -"
      ];

      users.users.zennotes = {
        isSystemUser = true;
        group = "zennotes";
        description = "ZenNotes server user";
        home = cfg.dataDir;
      };
      users.groups.zennotes = {};

      systemd.services.zennotes = {
        description = "ZenNotes Self-Hosted Markdown Server";
        wantedBy = ["multi-user.target"];
        after = ["network.target"];

        serviceConfig = {
          Type = "simple";
          User = "zennotes";
          Group = "zennotes";
          WorkingDirectory = cfg.dataDir;
          ExecStart = "${cfg.package}/bin/zennotes-server";
          Restart = "on-failure";

          # Systemd automatically creates these directories as root,
          # assigns them to user/group zennotes, and sets permissions BEFORE dropping privileges.
          StateDirectory = "zennotes"; # Creates /var/lib/zennotes (0750)

          # Security hardening options
          ProtectSystem = "strict";
          ProtectHome = true;
          NoNewPrivileges = true;
          ReadWritePaths = [cfg.dataDir cfg.vaultPath];
        };

        # Safe preStart: No root actions (chown/mkdir) required!
        preStart = ''
          if [ ! -f ${cfg.dataDir}/config.toml ]; then
            cp ${configFile} ${cfg.dataDir}/config.toml
            chmod 0640 ${cfg.dataDir}/config.toml
          fi
        '';

        environment =
          {
            PORT = toString cfg.port;
            ZENNOTES_BIND = "${cfg.bindAddress}:${toString cfg.port}";
            ZENNOTES_DEFAULT_VAULT_PATH = cfg.vaultPath;
            ZENNOTES_CONFIG_PATH = "${cfg.dataDir}/config.toml";
          }
          // cfg.extraEnvironment;
      };

      networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [cfg.port];
    }
  );
}

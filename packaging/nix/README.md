# Linux packaging (Nix / NixOS)

This directory holds the Nix packaging for ZenNotes.

## Test it before installing

You can use `nix run` to run the application without installing it:

For the desktop app:
```sh
nix run github:ZenNotes/zennotes
```

The self-hosted server is packaged in its own repository,
[ZenNotes/znserver](https://github.com/ZenNotes/znserver), which ships a
`default.nix` (`nix-build` in a checkout).

## Installing on NixOS

For now as the package is not in the official nixpkgs repo you will need to add an input in your `flake.nix`, like this:

```nix
inputs = {
  # ...

  zennotes.url = "github:ZenNotes/zennotes";
};

outputs = { nixpkgs, ... } @ inputs:
{
  # ...
};
```

And then you can add it to your system packages:

```nix
{ pkgs, inputs, ... }:

{
  environment.systemPackages = [
    inputs.zennotes.packages.${pkgs.system}.zennotes-desktop
  ];
}
```


If you don't use flakes you'll need to copy the `package-desktop.nix` file into your NixOS configuration and add it to your system packages:

```nix
environment.systemPackages = [
  (pkgs.callPackage ./package-desktop.nix { })
];
```

## Updating to a new release

1. Open `release-data.json`
2. Bump `version`:

```json
{
  "version": "2.3.0", // => 2.4.0
  // ...
}
```

2. Update the source hash
To obtain a new hash (replace X.X.X with the desired version):

```sh
nix-prefetch-github ZenNotes zennotes --rev "vX.X.X"
```

```json
{
  // ...
  "hash": "sha256-+tLPVnnMbtMa5blSwHav9ZMlnkUsrdG62mMGxhbmy6g=", // update to new hash
  // ...
}

```

3. Update the npmDepsHash (if needed)
To obtain a new npmDepsHash use this command in an updated project root:

```sh
prefetch-npm-deps package-lock.json
```

```json
{
  // ...
  "npmDepsHash": "sha256-7IpGnxVjaJvfSZyKjOylGMhFqa1bx8Ry5O1yqYfNnCE="
}
```

4. Build and test

```sh
nix build
./result/bin/zennotes-desktop
```

## Notes & limitations

* Automatic updates inside ZenNotes are disabled because Nix packages are immutable.
* Updates should be performed through Nix by updating the package definition.

{
  description = "Thunderbird Account Color Stripe extension";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      perSystem =
        { pkgs, ... }:
        let
          version = (builtins.fromJSON (builtins.readFile ./manifest.json)).version;
        in
        {
          # `nix build` -> result/account-stripe-<version>.xpi
          # An .xpi is just a zip with manifest.json at the root.
          packages.default = pkgs.runCommand "account-stripe-${version}.xpi" {
            nativeBuildInputs = [ pkgs.zip ];
          } ''
            mkdir -p $out
            cd ${./.}
            zip -r -X "$out/account-stripe-${version}.xpi" \
              manifest.json background.js api
          '';

          # `nix flake check` runs biome over the sources. biome needs no git,
          # so it just runs against the source copy directly.
          checks.biome = pkgs.runCommand "biome-check" {
            nativeBuildInputs = [ pkgs.biome ];
          } ''
            cd ${./.}
            biome check .
            touch $out
          '';

          devShells.default = pkgs.mkShell {
            # biome: formats + lints the JS/JSON.
            # prek: runs the biome check as a git hook (see prek.toml).
            # nodejs: quick `node --check`.
            packages = [
              pkgs.biome
              pkgs.prek
              pkgs.nodejs
            ];
          };
        };
    };
}

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
        {
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

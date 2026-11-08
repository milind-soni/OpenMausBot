{ pkgs ? import (builtins.fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/1d060086d60cb76a40cf37109f979d88a5bd6396.tar.gz";
    sha256 = "sha256-jQp1wKvbwWdLBASTXkSi/VYmDJ5AbBi1WvcMt9HWJC8=";
  }) {}
}:

pkgs.mkShell {
  passthru.bootstrapShell = pkgs.bashInteractive;
  packages = [
    pkgs.nodejs_24
    pkgs.git
    (pkgs.steam.override {
      extraPkgs = p: [ p.nss p.nspr p.at-spi2-atk p.libxcomposite ];
    }).run-free
  ];
  # steam-run has a private /tmp; nix-shell's temporary subdirectory is outside it.
  shellHook = ''
    export TMPDIR=/tmp
  '';
}

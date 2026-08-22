# Cua Driver redistribution records

These files accompany the exact Cua Driver `0.19.3` Linux x64 runtime bundled by OpenMausBot. The upstream release archive omits its own license, the embedded Inter font license, a dependency notice, an SBOM, and artifact provenance, so they are preserved here and verified during packaging.

Trust anchor:

- upstream commit: `a1672e7b11951275ecfba3384264d4530185d0db`;
- archive: `cua-driver-rs-0.19.3-linux-x86_64-binary.tar.gz`;
- archive SHA-256: `3db9d4257d84bacaf7eb104d225f85613ce67edbb20d6eeb83c1384b6d8a5b10`;
- driver SHA-256: `ed5844fadf07b9b72c4a3b3802e1c47233c166d66d6198608d5991f807aab4ac`;
- cursor-theme SHA-256: `e589b2b7521bbfeaf9e2bfce668a38e80ed1b9790b1327b13d374fc331d8312a`;
- upstream `Cargo.lock` SHA-256: `c1a8df7f4bedd554f6fc90c852c3625c91a89b28d9f2c642d966279e9e372362`;
- embedded Inter `4.001` SHA-256: `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031`.

`THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_LICENSES.html`, and `SBOM.cdx.json` are generated from two root-scoped `cargo-about 0.8.4` JSON reports. Do not feed the virtual workspace's raw `cargo metadata` graph to the generator: Cargo unifies features enabled by unrelated workspace members, which overstates the two release binaries.

The official [`cargo-about-0.8.4-x86_64-unknown-linux-musl.tar.gz`](https://github.com/EmbarkStudios/cargo-about/releases/download/0.8.4/cargo-about-0.8.4-x86_64-unknown-linux-musl.tar.gz) archive used for the reviewed output has SHA-256 `c7381aa0cdc41fc0ee662cec8daa260da7817ad8ddea04cd4ddad425460adf14`. From the exact upstream checkout's `libs/cua-driver/rust` directory, run:

```bash
cargo-about generate \
  --locked \
  --target x86_64-unknown-linux-gnu \
  --manifest-path crates/cua-driver/Cargo.toml \
  --features portal-input \
  --config /path/to/OpenMausBot/third_party/cua-driver/about.toml \
  --format json \
  > cua-driver.cargo-about.json

cargo-about generate \
  --locked \
  --target x86_64-unknown-linux-gnu \
  --manifest-path crates/cursor-theme-cli/Cargo.toml \
  --config /path/to/OpenMausBot/third_party/cua-driver/about.toml \
  --format json \
  > cursor-theme.cargo-about.json

node /path/to/OpenMausBot/scripts/generate-cua-sbom.mjs \
  cua-driver.cargo-about.json \
  cursor-theme.cargo-about.json \
  Cargo.lock \
  /path/to/OpenMausBot/third_party/cua-driver
```

The generator fails unless the reports contain the reviewed root-scoped sets: 325 registry packages for the driver, 113 for the cursor-theme sidecar, and a 330-package union. The final CycloneDX inventory contains those 330 packages, eight Cua workspace packages, and the embedded Inter font. The MPL-2.0 set is exactly seven packages. Regeneration is expected to produce a reviewed diff; no release process accepts new native inputs automatically.

OpenMausBot ships only the CLI and cursor-theme sidecar. The Linux SDK `.so`, Node `.node`, ABI header, and GNOME helper are not included in Phase 5 because the current runtime does not load them and must not silently install a Shell extension.
The app's npm Cua SDK is used by the separate macOS integration and may have a different version; it is not loaded by this Linux CLI-spawn runtime.

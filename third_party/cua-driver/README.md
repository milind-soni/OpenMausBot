# Cua Driver redistribution records

These files accompany the exact Cua Driver `0.41.3` Linux x64 runtime bundled by OpenMausBot. The upstream release archive omits its own license, the embedded Inter font license, a dependency notice, an SBOM, and artifact provenance, so they are preserved here and verified during packaging.

Trust anchor:

- upstream commit: `bd0e299c67dec6397b3d41a259452b2ea13a1cd5`;
- archive: `cua-driver-rs-0.41.3-linux-x86_64-binary.tar.gz`;
- archive SHA-256: `a00a7bc4a648adbcbc93bfbf5a058daf71ce8838ee172e33b197aaf649ecee14`;
- driver SHA-256: `83030028e7c9e3f4d753b3b27025135d44eb8d52f562cce0aaaf95777bc1b41f`;
- cursor-theme SHA-256: `d39efb960d207e7328d7a9dd48e3b6565f74be073f9c2ca8dcba86a4d0f28312`;
- upstream `Cargo.lock` SHA-256: `02ee8ebd8415e097036870a7fd39ba379c5e0d212a116715ca0660e83116f447`;
- embedded Inter `4.001` SHA-256: `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031`.

`THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_LICENSES.html`, and `SBOM.cdx.json` are generated from two root-scoped `cargo-about 0.8.4` JSON reports. Do not feed the virtual workspace's raw `cargo metadata` graph to the generator: Cargo unifies features enabled by unrelated workspace members, which overstates the two release binaries.

The 0.41.3 records were generated with the official [`cargo-about-0.8.4-aarch64-apple-darwin.tar.gz`](https://github.com/EmbarkStudios/cargo-about/releases/download/0.8.4/cargo-about-0.8.4-aarch64-apple-darwin.tar.gz) archive (SHA-256 `d5255ead3ac861a11c785bf19d4f70f16e59ac8b9519c312da61213d3d57351d`); the `--target` filter keeps the graph identical on any host. The upstream checkout must include `libs/cua/Cargo.toml` and `libs/cua/crates/cua-telemetry`, a path dependency of the driver that lives outside `libs/cua-driver/rust`. From the exact upstream checkout's `libs/cua-driver/rust` directory, run:

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

The generator fails unless the reports contain the reviewed root-scoped sets: 376 registry packages for the driver, 239 for the cursor-theme sidecar, and a 381-package union. The final CycloneDX inventory contains those 381 packages, ten Cua packages (nine driver workspace crates plus `cua-telemetry` 0.12.1 from `libs/cua`), and the embedded Inter font. The MPL-2.0 set is exactly seven packages. Regeneration is expected to produce a reviewed diff; no release process accepts new native inputs automatically.

OpenMausBot ships only the CLI and cursor-theme sidecar. The Linux SDK `.so`, Node `.node`, ABI header, and GNOME helper are not included in Phase 5 because the current runtime does not load them and must not silently install a Shell extension.
The app's npm Cua SDK is used by the separate macOS integration and may have a different version; it is not loaded by this Linux CLI-spawn runtime.

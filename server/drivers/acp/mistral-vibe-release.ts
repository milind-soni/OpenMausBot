// Mistral Vibe's own build, for installing `vibe-acp` without Python or uv: the build
// github.com/mistralai/mistral-vibe ships for version 3.1.2 (releases/download/v3.1.2).
// Mistral publishes no checksum file. Each archive SHA-256 below was measured on 2026-11-14 by downloading the asset
// once and running `shasum -a 256`; each size is that download's byte count. Each program SHA-256 is `shasum -a 256` of
// `vibe-acp` unpacked from the same archive (`tar -xzO` / `unzip -p`); the app checks it after unpacking, before
// reusing an installed copy and at every start. The archive carries `vibe-acp` beside its `_internal/` PyInstaller
// bundle, so the executable is run in place. The macOS builds' code signature is adhoc (no Team ID), so the pin sets
// no `macTeamId`; Windows ships x64 only.
// `mistral-vibe` is current on PyPI at 3.1.2 too; the vendor's `install.sh` installs that package through uv.
import type { StandaloneRelease } from "../../contracts.ts";

const VERSION = "3.1.2";
const RELEASE = `https://github.com/mistralai/mistral-vibe/releases/download/v${VERSION}`;

export const MISTRAL_VIBE_STANDALONE: StandaloneRelease = {
  name: "Mistral Vibe",
  engine: "vibe-acp",
  version: VERSION,
  // github.com answers with a redirect to GitHub's release-asset host.
  hosts: ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"],
  assets: {
    "darwin-arm64": { url: `${RELEASE}/vibe-acp-darwin-aarch64-3.1.2.tar.gz`, archive: "tar.gz", executable: "vibe-acp", approxBytes: 68_858_580, sha256: "cff30ab96c08e77e3628160fb5dd7ebde78dd24cff624e03465c8618b9c05020", executableSha256: "bffbd823f7da50e4c499fe52abf3888a63874995795318c171081bb8878538b1" },
    "darwin-x64": { url: `${RELEASE}/vibe-acp-darwin-x86_64-3.1.2.tar.gz`, archive: "tar.gz", executable: "vibe-acp", approxBytes: 70_461_490, sha256: "8fc70f9dec996d2a8713005bd94d97ed53d145fdd503c00b3abf4807f15a66dd", executableSha256: "265ec8f7f5884561737541028a260e3738301ed5e401caa29b8628af1d522ee5" },
    "linux-x64": { url: `${RELEASE}/vibe-acp-linux-x86_64-3.1.2.tar.gz`, archive: "tar.gz", executable: "vibe-acp", approxBytes: 113_009_772, sha256: "cc63ca1ac92990f4e39724559710a3303bdb20fa4b4dc377cf544a023de7bdee", executableSha256: "278a3ad966b2923404c5317ac96a4094542539c89a7e6741ccc2402bf425ae2e" },
    "linux-arm64": { url: `${RELEASE}/vibe-acp-linux-aarch64-3.1.2.tar.gz`, archive: "tar.gz", executable: "vibe-acp", approxBytes: 106_819_919, sha256: "f357e53a9e7ad0ac214fd30f94c211ffceb3b968f20dee5e92c1742bee066ac2", executableSha256: "4ce303fffd65ec1d20b221819b07f8c0bf3441d97dc54100f135b493c7f90831" },
    "win32-x64": { url: `${RELEASE}/vibe-acp-windows-x86_64-3.1.2.zip`, archive: "zip", executable: "vibe-acp.exe", approxBytes: 68_737_578, sha256: "e5fa0e032633e79ec0cc77450ea303a8ddf98babcc8ad99c0bcc4f5f38d9a01c", executableSha256: "66b47be03f453ba84aa8b7ddd68b79cd7a846b145af4666ec994767df9e329b1" },
  },
};

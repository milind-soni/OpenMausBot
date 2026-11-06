// OpenCode's own builds, for installing it without Node.js: the version `npm install -g @opencode/cli` gives (latest on
// npm, 2026-10-30), from https://github.com/anomalyco/opencode/releases/tag/v2.2.5.
// Anomaly publishes a SHA256SUMS file for this release; each archive SHA-256 below was taken from that file and
// re-measured on 2026-11-03 by downloading the asset and running `sha256sum` on it — both agree. Each size is the byte
// count the GitHub assets API and the finished download agree on. Each program SHA-256 is `sha256sum` of the executable
// unpacked from that same verified archive (`unzip -p` / `tar -xzO`); the app checks it after unpacking, before reusing
// an installed copy and at every start. The 1.x executables keep their place in `previousPrograms`, so copies installed
// by earlier pins stay usable until they update. x64 takes the "baseline" builds, which need no AVX2 (older Intel CPUs,
// Rosetta); a Linux without glibc takes the musl builds. The macOS arm64 executable is signed with Anomaly Innovations'
// Developer ID, Team 5NZ4Q7NXJ4 (checked with codesign on 2026-11-05).
import type { StandaloneRelease } from "../../contracts.ts";

const VERSION = "2.2.5";
const RELEASE = `https://github.com/anomalyco/opencode/releases/download/v${VERSION}`;

export const OPENCODE_STANDALONE: StandaloneRelease = {
  name: "OpenCode",
  engine: "opencode",
  version: VERSION,
  // github.com answers with a redirect to GitHub's release-asset host.
  hosts: ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"],
  macTeamId: "5NZ4Q7NXJ4",
  // The app installs its own copy's updates; OpenCode's self-updater would replace that copy behind its back.
  runEnv: { OPENCODE_DISABLE_AUTOUPDATE: "1" },
  // Program hashes of earlier pins whose installed copies stay usable after this pin moves on: the 1.x line, whose npm
  // name (`opencode-ai`) the previous install command used.
  previousPrograms: {
    "darwin-arm64": ["417af53923f3d529759ab85ce3e8dd09116f742efcd332de591d2da6ebae696b"],
    "darwin-x64": ["362c45dcd36a16215dce88c6b5232fe230f542c25960f01ba4e4a35588f42de9"],
    "linux-x64": ["538fcb1b6408c8d4608822acee19f7ff5b3a3eb3383c0633c4f06170857312a7"],
    "linux-arm64": ["eba0da50d9cc22f2dd062c32e0e7e58d7ece301aa50aabdad1e9dba4ffbf25b4"],
    "linux-x64-musl": ["ad5ae0ab7b5f0c6fec273648eb91c798fd49ffe0e3f222dcec3ab2d680b132d8"],
    "linux-arm64-musl": ["2a0cfa6fe7d96ebb89da8d880bd884598d5cdca10e6c3a5b2e63f92c569f1452"],
    "win32-x64": ["eba9fc042ac622648a66ac5764c5ad41a73244eabcd7a00527d651b7c443efbd"],
    "win32-arm64": ["92c6c5f6f656e60d6809c029a911ecb578204085945dd2f6e2639981ecab8749"],
  },
  assets: {
    "darwin-arm64": { url: `${RELEASE}/opencode-darwin-arm64.zip`, archive: "zip", executable: "opencode", approxBytes: 105_851_917, sha256: "25ba9908979fa7d764792c82589b4b5768ab1511154e0317d98aa77d216ce767", executableSha256: "abe4d88594bffb12b364375b8a6732d2d1f7a977195ed1a35c5c76f8e89c9e0e" },
    "darwin-x64": { url: `${RELEASE}/opencode-darwin-x64-baseline.zip`, archive: "zip", executable: "opencode", approxBytes: 111_093_665, sha256: "b83ab73b3eb7b08f580f597eba8a7bcd886d2efa2ebf90405ad74ef54da02f71", executableSha256: "f2e7af7237a08e970821aec92c6af95caadeab2fe9f54bd4e76e075d8092d47f" },
    "linux-x64": { url: `${RELEASE}/opencode-linux-x64-baseline.tar.gz`, archive: "tar.gz", executable: "opencode", approxBytes: 119_196_162, sha256: "09f44302c10fd036912f59c81fd1aef5df45dd06f649197f9dfc9bbe2a79614e", executableSha256: "8d060e1d2fbb9bb44cf09ae6ed1f3f6a7cff070b5227e2f90970132b23a92050" },
    "linux-arm64": { url: `${RELEASE}/opencode-linux-arm64.tar.gz`, archive: "tar.gz", executable: "opencode", approxBytes: 117_861_733, sha256: "5a528f42caf576c6cdece6a191eb273d3db54effa5518e0402684d8f8026aeb6", executableSha256: "dcc7e6f4ac1672e1884dcb8d26ab333e55ffc3f080e01a7a60177aa05f54935f" },
    "linux-x64-musl": { url: `${RELEASE}/opencode-linux-x64-baseline-musl.tar.gz`, archive: "tar.gz", executable: "opencode", approxBytes: 117_818_616, sha256: "889389e99ffa39fa41d512b2c9c15316522d97398fb912503ef667f80e22a827", executableSha256: "8b071dcb704137eb9be83cd84ebd634e9409f9b9aaf9d8e562e1c69941743ce4" },
    "linux-arm64-musl": { url: `${RELEASE}/opencode-linux-arm64-musl.tar.gz`, archive: "tar.gz", executable: "opencode", approxBytes: 116_087_436, sha256: "bbf927e3f7a92040f25fd78436c251f41deb25cefac1c906e79c01aa572bf73b", executableSha256: "2d719ef7b593a3e836dab611bc28da0e9ee71958d5e72ddb41e0f6abe2924e14" },
    "win32-x64": { url: `${RELEASE}/opencode-windows-x64-baseline.zip`, archive: "zip", executable: "opencode.exe", approxBytes: 121_962_395, sha256: "3acca208ad79add59aed13d07b7e08ddf24e0adbbb7f44a9131408d7b3ca67cd", executableSha256: "17531635c255d2dd70057b8d50564b829349eae8c2946590ce355f003cb251e6" },
    "win32-arm64": { url: `${RELEASE}/opencode-windows-arm64.zip`, archive: "zip", executable: "opencode.exe", approxBytes: 115_405_131, sha256: "4e426a39d68516b036cd28b574c5ce5f3b50846ab460521f83f2458fe7f242d8", executableSha256: "a614cd11e3c98fb57ce2d3a45988f163ec15689269ee4cea64ee7cf6b2d1b1ee" },
  },
};

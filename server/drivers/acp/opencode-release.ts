// OpenCode's own builds, for installing it without Node.js: the version `npm install -g @opencode/cli` gives (latest on
// npm, 2026-11-18), from https://github.com/anomalyco/opencode/releases/tag/v2.3.2.
// Anomaly publishes a SHA256SUMS file for this release; each archive SHA-256 below was taken from that file and
// re-measured on 2026-11-18 by downloading the asset and running `shasum -a 256` on it, and equals the `digest` GitHub
// reports for that asset — all three agree. Each size is the byte count the GitHub assets API and the finished download
// agree on. Each program SHA-256 is `shasum -a 256` of the executable unpacked from that same verified archive (`unzip -p`
// / `tar -xzO`); the app checks it after unpacking, before reusing an installed copy and at every start. Every archive
// still holds a single file at its root, the executable. The 1.x and 2.2.5 executables keep their place in
// `previousPrograms`, so copies installed by earlier pins stay usable until they update. x64 takes the "baseline" builds,
// which need no AVX2 (older Intel CPUs, Rosetta); a Linux without glibc takes the musl builds. Both macOS executables are
// signed with Anomaly Innovations' Developer ID, Team 5NZ4Q7NXJ4 (checked with codesign on 2026-11-18).
import type { StandaloneRelease } from "../../contracts.ts";

const VERSION = "2.3.2";
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
  // name (`opencode-ai`) an earlier install command used, then 2.2.5.
  previousPrograms: {
    "darwin-arm64": ["417af53923f3d529759ab85ce3e8dd09116f742efcd332de591d2da6ebae696b", "abe4d88594bffb12b364375b8a6732d2d1f7a977195ed1a35c5c76f8e89c9e0e"],
    "darwin-x64": ["362c45dcd36a16215dce88c6b5232fe230f542c25960f01ba4e4a35588f42de9", "f2e7af7237a08e970821aec92c6af95caadeab2fe9f54bd4e76e075d8092d47f"],
    "linux-x64": ["538fcb1b6408c8d4608822acee19f7ff5b3a3eb3383c0633c4f06170857312a7", "8d060e1d2fbb9bb44cf09ae6ed1f3f6a7cff070b5227e2f90970132b23a92050"],
    "linux-arm64": ["eba0da50d9cc22f2dd062c32e0e7e58d7ece301aa50aabdad1e9dba4ffbf25b4", "dcc7e6f4ac1672e1884dcb8d26ab333e55ffc3f080e01a7a60177aa05f54935f"],
    "linux-x64-musl": ["ad5ae0ab7b5f0c6fec273648eb91c798fd49ffe0e3f222dcec3ab2d680b132d8", "8b071dcb704137eb9be83cd84ebd634e9409f9b9aaf9d8e562e1c69941743ce4"],
    "linux-arm64-musl": ["2a0cfa6fe7d96ebb89da8d880bd884598d5cdca10e6c3a5b2e63f92c569f1452", "2d719ef7b593a3e836dab611bc28da0e9ee71958d5e72ddb41e0f6abe2924e14"],
    "win32-x64": ["eba9fc042ac622648a66ac5764c5ad41a73244eabcd7a00527d651b7c443efbd", "17531635c255d2dd70057b8d50564b829349eae8c2946590ce355f003cb251e6"],
    "win32-arm64": ["92c6c5f6f656e60d6809c029a911ecb578204085945dd2f6e2639981ecab8749", "a614cd11e3c98fb57ce2d3a45988f163ec15689269ee4cea64ee7cf6b2d1b1ee"],
  },
  assets: {
    "darwin-arm64": { url: `${RELEASE}/opencode-darwin-arm64.zip`, archive: "zip", executable: "opencode", approxBytes: 109_126_744, sha256: "31ab5a06a29edc7e49b895f35c2b64ebfe7c7f0437b0f2581b006efcd79fee1a", executableSha256: "635c523002b6eaf897597facba703729794cb07bdb59044d5e173b07b77ff934" },
    "darwin-x64": { url: `${RELEASE}/opencode-darwin-x64-baseline.zip`, archive: "zip", executable: "opencode", approxBytes: 114_496_820, sha256: "6dc5deb4554df035d27dbb3a4663d96954969a33079aeb6b01dd9de2d9092545", executableSha256: "5d188d68f808570aa1f8826c9d6bd7d9ade18e9bac8961aa3c0079f41e2850e8" },
    "linux-x64": { url: `${RELEASE}/opencode-linux-x64-baseline.tar.gz`, archive: "tar.gz", executable: "opencode", approxBytes: 122_641_607, sha256: "563b5d663637226b6e3bb4bb6803281bc39b0d2cd88db06d674b6420aab009b0", executableSha256: "e6543f6e5c39c40971ba38afd1819ac852c29ac735b5a89065d3d148d47f27ad" },
    "linux-arm64": { url: `${RELEASE}/opencode-linux-arm64.tar.gz`, archive: "tar.gz", executable: "opencode", approxBytes: 121_172_970, sha256: "9d10185acdb72336e086e699ca363a6065f410fd3c1caed0dc8046e95ac06ccb", executableSha256: "fc1ad8f2dffed8494e31265837f78d1e6ce5200f5c1c50e953cd9b63e607efdb" },
    "linux-x64-musl": { url: `${RELEASE}/opencode-linux-x64-baseline-musl.tar.gz`, archive: "tar.gz", executable: "opencode", approxBytes: 122_453_192, sha256: "4e952a67874cfdb4f53eeae5840f9813acc9f109c10e61bc26020271f56d7d84", executableSha256: "338bad40b5b5f602af50ebb995036bb6965d25deffc9d88df3f69ddc04524a17" },
    "linux-arm64-musl": { url: `${RELEASE}/opencode-linux-arm64-musl.tar.gz`, archive: "tar.gz", executable: "opencode", approxBytes: 120_472_892, sha256: "2148ba748f5410177868ed67d59ef70626cb6bd4fb2abc5177c807adfdc24fc3", executableSha256: "0e214ccebc6f0dd8775be65104b8a9de0585427b8911ad838c9fd83d1c812e2d" },
    "win32-x64": { url: `${RELEASE}/opencode-windows-x64-baseline.zip`, archive: "zip", executable: "opencode.exe", approxBytes: 125_643_830, sha256: "8dcfe392a79412bf908de4c0cf5338c52589147eff54f1a46c25fb24a94708e7", executableSha256: "ba343b5c0fd8d7daabc0501bd1c1866c0fd91e8ff7b4404f5524fbc0cc233882" },
    "win32-arm64": { url: `${RELEASE}/opencode-windows-arm64.zip`, archive: "zip", executable: "opencode.exe", approxBytes: 118_889_090, sha256: "13dabbf6874c8abfc7ff44bee0e64c3758e918a0e27f56f74173c353d56a842d", executableSha256: "cde2ef5e052143ecca725af3ab330e00b7b7ab6bab1b971bb1a9467fc2c15063" },
  },
};

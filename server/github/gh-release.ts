// GitHub CLI (`gh`, MIT, github.com/cli/cli), for signing in to GitHub where the person has none of their own: a Cloud
// home's image ships git but not gh. It is installed on the first sign-in through the same checked pipeline as the AIs'
// own builds (engine-standalone.ts), never at start-up: it is not in STANDALONE_RELEASES, so no boot step looks at it.
// From https://github.com/cli/cli/releases/tag/v2.103.3 (2026-10-26). Each archive SHA-256 is the `digest` GitHub reports
// for the asset, and equals the line in gh_2.103.3_checksums.txt and `shasum -a 256` of the downloaded file (all three
// checked on 2026-11-24). Each size is the asset's byte count. Each program SHA-256 is `shasum -a 256` of bin/gh (or
// bin/gh.exe) unpacked from that verified archive (`tar -xzO` / `unzip -p`). The macOS programs are signed with GitHub's
// Developer ID, Team VEKTX9H2N7 (codesign -dvv on 2026-11-24). gh is a static Go program, so the glibc builds also run
// on a Linux without glibc.
import type { StandaloneAsset, StandaloneRelease } from "../contracts.ts";

export const GH_VERSION = "2.103.3";
const RELEASE = `https://github.com/cli/cli/releases/download/v${GH_VERSION}`;
const dir = (platform: string) => `gh_${GH_VERSION}_${platform}`;

const LINUX_X64: StandaloneAsset = { url: `${RELEASE}/${dir("linux_amd64")}.tar.gz`, archive: "tar.gz", executable: `${dir("linux_amd64")}/bin/gh`, approxBytes: 15_031_972, sha256: "4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d", executableSha256: "b768184570b12536be4ac1528893f6340d1c6a7b40b56ad45bca9cd0e87ad34d" };
const LINUX_ARM64: StandaloneAsset = { url: `${RELEASE}/${dir("linux_arm64")}.tar.gz`, archive: "tar.gz", executable: `${dir("linux_arm64")}/bin/gh`, approxBytes: 13_661_485, sha256: "ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63", executableSha256: "a82a52e1bbe05bcd485f8cbbd5aa67e11a76fce6bdad394a2d179e1c24cfe367" };

export const GH_STANDALONE: StandaloneRelease = {
  name: "GitHub CLI",
  engine: "github-cli",
  version: GH_VERSION,
  // github.com answers with a redirect to GitHub's release-asset host.
  hosts: ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"],
  macTeamId: "VEKTX9H2N7",
  // gh's own update check would tell the server about a newer gh it cannot install; the pin moves with a release.
  runEnv: { GH_NO_UPDATE_NOTIFIER: "1", GH_TELEMETRY: "false", DO_NOT_TRACK: "1" },
  assets: {
    "linux-x64": LINUX_X64,
    "linux-arm64": LINUX_ARM64,
    "linux-x64-musl": LINUX_X64,
    "linux-arm64-musl": LINUX_ARM64,
    "darwin-x64": { url: `${RELEASE}/${dir("macOS_amd64")}.zip`, archive: "zip", executable: `${dir("macOS_amd64")}/bin/gh`, approxBytes: 15_702_601, sha256: "a2f86418f4350ae6e9ec60d5000bdf7665728436946a97fc27fe50e6ae752682", executableSha256: "547afd9491efe0730c7f42791b53529dccecda647837155cbd18ddedf92f799f" },
    "darwin-arm64": { url: `${RELEASE}/${dir("macOS_arm64")}.zip`, archive: "zip", executable: `${dir("macOS_arm64")}/bin/gh`, approxBytes: 14_106_091, sha256: "d700207eae9ae98fe2b89535c2c087c07823d4628c56364695a5a07ef311c062", executableSha256: "5f8d7527e2bdf584249b030cdd1550c91d75e8afb40aa3c11573d416817a1260" },
    "win32-x64": { url: `${RELEASE}/${dir("windows_amd64")}.zip`, archive: "zip", executable: "bin/gh.exe", approxBytes: 15_197_187, sha256: "98d0cfa794721665d7973dd728c78aff7bd836d58f10f6d7a03568eccb0a22e0", executableSha256: "d303d8ac3f5e9438bf7c977b64dd6425513eae46218f8881d30694f28c1d0dfd" },
    "win32-arm64": { url: `${RELEASE}/${dir("windows_arm64")}.zip`, archive: "zip", executable: "bin/gh.exe", approxBytes: 13_637_549, sha256: "197211c98687d7770ac331fe8a3b6c198c389108c1536cdbedf659fe4703e484", executableSha256: "c387d066328aadb51a8c385f7d361995589904c4fcec1b412957b033e97b3dad" },
  },
};

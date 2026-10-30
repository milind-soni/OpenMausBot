// URLs and hashes come from Google's official ACP registry entry. Archive and
// member sizes were read from Google's servers on 2026-10-25; the win32-x64
// archive was downloaded and its hash checked independently.
// Registry: agentclientprotocol/registry@06229c691d24d039e2363ba12abe5c9dfae5bc66
export const ANTIGRAVITY_RELEASE_VERSION = "1.4.3";

export interface AntigravityReleaseAsset {
  version: string;
  url: string;
  sha256: string;
  archiveBytes: number;
  executable: { name: string; bytes: number };
  harness: { name: string; bytes: number };
}

const RELEASES = new Map<string, AntigravityReleaseAsset>([
  [
    "darwin-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.3-darwin-arm64.zip",
      sha256: "c57db0a9b8b712daa9c3c17cdb990a61842ea569f279e8bd79d7aa85a303b20b",
      archiveBytes: 114_147_623,
      executable: { name: "agy_acp_server.par", bytes: 282_446_160 },
      harness: { name: "localharness_external", bytes: 122_957_936 },
    },
  ],
  [
    "linux-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.3-linux-x86_64.zip",
      sha256: "0634ce5306ba92c932945455e7a83fda78e2d99c33fa8aa6ee0566206a382714",
      archiveBytes: 336_846_435,
      executable: { name: "agy_acp_server.par", bytes: 927_707_135 },
      harness: { name: "localharness_external", bytes: 133_926_136 },
    },
  ],
  [
    "linux-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.3-linux-arm64.zip",
      sha256: "05c153443b0b1175151c760eeddea538950bc9843e317d54786a1f03670182bc",
      archiveBytes: 322_887_047,
      executable: { name: "agy_acp_server.par", bytes: 932_662_106 },
      harness: { name: "localharness_external", bytes: 127_512_832 },
    },
  ],
  [
    "win32-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.3-windows-x86_64.zip",
      sha256: "54c2e16378d9a4952e1da70e355f3c33c4f284308d6de48ab3e6e34a127bd325",
      archiveBytes: 131_267_135,
      executable: { name: "agy_acp_server.exe", bytes: 87_022_872 },
      harness: { name: "localharness_external.exe", bytes: 147_843_736 },
    },
  ],
  [
    "win32-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.3-windows-arm64.zip",
      sha256: "fcd46431ad33d3b510ce0b98fe7b43d095bd8b3f1c363ee2d57faa7ee981c7bb",
      archiveBytes: 134_301_870,
      executable: { name: "agy_acp_server.exe", bytes: 94_238_816 },
      harness: { name: "localharness_external.exe", bytes: 139_322_008 },
    },
  ],
]);

export function resolveAntigravityReleaseAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): AntigravityReleaseAsset | null {
  return RELEASES.get(`${platform}-${arch}`) ?? null;
}

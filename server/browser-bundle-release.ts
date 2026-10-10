// Reviewed vendor assets, downloaded and hashed on 2026-09-16. Update all
// pins together and run each platform's packaged, offline browser smoke test.
// This is Chromium's headless shell, not full Chrome (which includes Widevine).
import { join } from "node:path";
import {
  agentBrowserReleaseUrl,
  agentBrowserReleaseVersion,
  resolveAgentBrowserReleaseAsset,
} from "./browser-engine-release.ts";

export const CHROME_VERSION = "153.0.8010.47";
export const SUPPORTED_BROWSER_TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"] as const;
export type BrowserBundleTarget = typeof SUPPORTED_BROWSER_TARGETS[number];

const CHROME_ASSETS = {
  "darwin-arm64": { platform: "mac-arm64", bytes: 98668949, sha256: "6d28839675b6f22dbd7ba8775dbdabcae7a5be37b482380b27b12f05b748b955", executableSha256: "111ee425ea5b0a01dcb19fda16452a9be0319749cba374b1c987d2437d8dcedb" },
  "darwin-x64": { platform: "mac-x64", bytes: 103712919, sha256: "aa178547f9751fbcf413e0f57915ddb72e83064d4d1c4a29dc1719b169f9cc2f", executableSha256: "33452695b1b6f18db2f796a422eca69b69ca8aacce36d1ff8c6f5d69eac1a635" },
  "linux-arm64": { platform: "linux-arm64", bytes: 120245582, sha256: "af0931a58d6bab688112d5ca1f7abd6d95c0b8a296ef34637f272795787774d7", executableSha256: "b6a9f0483c976fddc72c34ce1c983a1275163cdfb95576874bfed5ff07c53807" },
  "linux-x64": { platform: "linux64", bytes: 119695587, sha256: "7728775cf4a35464cd81c8eea2d44d6d32ccc0bd1edfa75aea7f32d146963d63", executableSha256: "ea90dee9cbd7b17f197eb6c386bd9f1ff636734ee99753cd2408658c45358bf2" },
  "win32-x64": { platform: "win64", bytes: 120466147, sha256: "9f405cfaf7bc08bf9e046e653cd3086c0faa1d4e25907de857f7e7f093a20122", executableSha256: "01176f6928faeb37ff018bc8884bbca8a0197f51b659d467f2501ab2c64f9fcf" },
} as const;

export function browserBundleSpec(target: string) {
  if (!Object.hasOwn(CHROME_ASSETS, target)) throw new Error(`Unsupported desktop browser target: ${target}`);
  const pinned = CHROME_ASSETS[target as BrowserBundleTarget];
  const [platform, arch] = target.split("-");
  const engine = resolveAgentBrowserReleaseAsset(platform as NodeJS.Platform, arch)!;
  const suffix = platform === "win32" ? ".exe" : "";
  const directory = `chrome-headless-shell-${pinned.platform}`;
  return {
    schemaVersion: 1,
    target,
    engine: {
      version: agentBrowserReleaseVersion(engine),
      asset: engine.asset,
      url: agentBrowserReleaseUrl(engine),
      bytes: engine.bytes,
      sha256: engine.sha256,
      executable: `agent-browser${suffix}`,
    },
    chrome: {
      version: CHROME_VERSION,
      asset: `${directory}.zip`,
      url: `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${pinned.platform}/${directory}.zip`,
      bytes: pinned.bytes,
      sha256: pinned.sha256,
      executableSha256: pinned.executableSha256,
      executable: `chrome/${directory}/chrome-headless-shell${suffix}`,
      license: `chrome/${directory}/LICENSE.headless_shell`,
      about: `chrome/${directory}/ABOUT`,
    },
  };
}

/** bundleDirectory is the target's directory, e.g. Resources/browser-engine. */
export function browserBundlePaths(bundleDirectory: string, target: string) {
  const spec = browserBundleSpec(target);
  return {
    directory: bundleDirectory,
    manifest: join(bundleDirectory, "manifest.json"),
    engine: join(bundleDirectory, spec.engine.executable),
    chrome: join(bundleDirectory, spec.chrome.executable),
    licenses: join(bundleDirectory, "licenses"),
  };
}

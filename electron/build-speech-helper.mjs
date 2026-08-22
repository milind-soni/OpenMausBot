// Build the native recognizer as a real app bundle. macOS privacy enforcement
// does not accept a purpose string embedded in a loose command-line binary on
// current releases; TCC reads the Info.plist belonging to the executable's
// bundle and terminates the process before Swift can recover when it is absent.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(electronDir);
const resourcesDir = path.join(electronDir, "resources");

export const speechHelperBundle = path.join(resourcesDir, "OpenMausBot Speech.app");
export const speechHelperBinary = path.join(speechHelperBundle, "Contents", "MacOS", "speech-helper");

export function buildSpeechHelper() {
  const contents = path.join(speechHelperBundle, "Contents");
  mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  copyFileSync(path.join(resourcesDir, "speech-helper-Info.plist"), path.join(contents, "Info.plist"));
  // The mac app ships for arm64 and x64, and the helper rides inside both
  // bundles, so it must be universal — bare `swiftc` builds host-arch only,
  // which inside an Intel app is a dictation helper that cannot launch.
  // macos12 matches the app's LSMinimumSystemVersion; the Speech/AVFoundation
  // APIs used here are all older than that.
  const slices = ["arm64", "x86_64"].map((arch) => {
    const slice = `${speechHelperBinary}-${arch}`;
    execFileSync(
      "swiftc",
      ["-O", "-target", `${arch}-apple-macos12`, path.join(resourcesDir, "speech-helper.swift"), "-o", slice],
      { stdio: "inherit", timeout: 120_000 },
    );
    return slice;
  });
  execFileSync("lipo", ["-create", ...slices, "-output", speechHelperBinary], {
    stdio: "inherit",
    timeout: 60_000,
  });
  for (const slice of slices) rmSync(slice, { force: true });
  const archs = execFileSync("lipo", ["-archs", speechHelperBinary], { timeout: 60_000 }).toString();
  if (!archs.includes("arm64") || !archs.includes("x86_64")) {
    throw new Error(`speech helper is not universal: ${archs.trim()}`);
  }
  // Give development builds a stable identity and the same audio entitlement
  // as the release. electron-builder replaces this ad-hoc signature when it
  // signs the containing distribution.
  execFileSync(
    "codesign",
    [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--entitlements",
      path.join(projectDir, "build", "entitlements.mac.plist"),
      speechHelperBundle,
    ],
    { stdio: "inherit", timeout: 30_000 },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildSpeechHelper();
}

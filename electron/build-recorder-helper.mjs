// Build the global-input observer as a real macOS app bundle. A stable bundle
// identity is required for Accessibility/Input Monitoring consent to persist.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(electronDir);
const resourcesDir = path.join(electronDir, "resources");

export const recorderHelperBundle = path.join(resourcesDir, "OpenMausBot Recorder.app");
export const recorderHelperBinary = path.join(recorderHelperBundle, "Contents", "MacOS", "recorder-helper");

export function buildRecorderHelper() {
  const contents = path.join(recorderHelperBundle, "Contents");
  mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  copyFileSync(path.join(resourcesDir, "recorder-helper-Info.plist"), path.join(contents, "Info.plist"));
  const slices = ["arm64", "x86_64"].map((arch) => {
    const slice = `${recorderHelperBinary}-${arch}`;
    execFileSync(
      "swiftc",
      ["-O", "-target", `${arch}-apple-macos12`, path.join(resourcesDir, "recorder-helper.swift"), "-o", slice],
      { stdio: "inherit", timeout: 120_000 },
    );
    return slice;
  });
  execFileSync("lipo", ["-create", ...slices, "-output", recorderHelperBinary], {
    stdio: "inherit",
    timeout: 60_000,
  });
  for (const slice of slices) rmSync(slice, { force: true });
  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--options", "runtime", "--entitlements", path.join(projectDir, "build", "entitlements.mac.plist"), recorderHelperBundle],
    { stdio: "inherit", timeout: 30_000 },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildRecorderHelper();
}

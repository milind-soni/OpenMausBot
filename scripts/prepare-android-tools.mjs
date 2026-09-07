// Stage Google's official Android Platform Tools beside the packaged app so
// USB phone support works on a clean machine without Homebrew or an SDK.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const platformNames = { darwin: "darwin", linux: "linux", win32: "win32" };
const releases = {
  darwin: { name: "platform-tools_r37.0.1-darwin.zip", sha256: "ee39ad5967e95c2a07f04dbcbde96b1a0c916ba376096db5d2f498b7727a5d1d" },
  linux: { name: "platform-tools_r37.0.1-linux.zip", sha256: "d230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1" },
  win32: { name: "platform-tools_r37.0.1-win.zip", sha256: "45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99" },
};
const platform = platformNames[process.platform];
const release = releases[process.platform];
if (!platform || !release) throw new Error(`Android Platform Tools are unsupported on ${process.platform}`);

const finalDir = join(root, "dist-native", "android-platform-tools", platform);
const temporary = mkdtempSync(join(tmpdir(), "openmaus-android-tools-"));
const staged = join(temporary, platform);

try {
  const archiveDir = process.env.OMB_ANDROID_PLATFORM_TOOLS_ARCHIVE_DIR;
  let bytes;
  if (archiveDir) {
    const cached = join(archiveDir, release.name);
    if (!existsSync(cached)) throw new Error(`Android Platform Tools archive is missing: ${cached}`);
    bytes = readFileSync(cached);
  } else {
    const url = `https://dl.google.com/android/repository/${release.name}`;
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`could not download Android Platform Tools: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== release.sha256) {
    throw new Error(`${release.name} failed SHA-256 verification (expected ${release.sha256}, received ${digest})`);
  }
  const zip = join(temporary, basename(release.name));
  writeFileSync(zip, bytes, { mode: 0o600 });
  const extraction = join(temporary, "extracted");
  mkdirSync(extraction);
  // A bare "tar" is Windows' bundled bsdtar (zip-capable) in cmd/PowerShell
  // but git-bash puts GNU tar (cannot read .zip) ahead of it on PATH, so
  // name the System32 binary absolutely — it extracts zips and understands
  // C:\ paths from any shell. unzip is the fallback for the rare Windows
  // without System32 tar, and the norm everywhere else.
  const systemTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  const extractors = process.platform === "win32"
    ? [[systemTar, ["-xf", zip, "-C", extraction]], ["unzip", ["-q", zip, "-d", extraction]]]
    : [["unzip", ["-q", zip, "-d", extraction]]];
  // spawnSync leaves stdout/stderr undefined when the binary itself is
  // missing (ENOENT) — report result.error instead of crashing on .trim().
  const describeFailure = (r) => r.error?.message ?? (`${r.stderr || r.stdout || ""}`.trim() || `exit status ${r.status}`);
  let result;
  for (const [command, args] of extractors) {
    result = spawnSync(command, args, { encoding: "utf8" });
    if (result.status === 0) break;
    console.error(`${command} failed: ${describeFailure(result)} — trying next`);
  }
  if (result.status !== 0) throw new Error(`could not extract Android Platform Tools: ${describeFailure(result)}`);
  cpSync(join(extraction, "platform-tools"), staged, { recursive: true });

  const adb = join(staged, process.platform === "win32" ? "adb.exe" : "adb");
  if (!existsSync(adb)) throw new Error("Downloaded Android Platform Tools do not contain adb");
  mkdirSync(dirname(finalDir), { recursive: true });
  rmSync(finalDir, { recursive: true, force: true });
  cpSync(staged, finalDir, { recursive: true });
  console.log(`staged Android Platform Tools at ${finalDir}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

// Builds the macOS 12.3–14 computer-use helper as a universal binary, then stages it per arch
// for electron-builder's extraResources. Clang only: no Swift, no ScreenCaptureKit.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("build:cua:mac12 is macOS-only; nothing to build here.");
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "electron", "resources", "cua-mac12");
const output = join(source, "cua-driver-mac12");
const frameworks = ["Foundation", "AppKit", "ApplicationServices", "CoreGraphics", "ImageIO", "Carbon"]
  .flatMap((name) => ["-framework", name]);
const sources = readdirSync(source)
  .filter((name) => name.endsWith(".m"))
  .map((name) => join(source, name));
if (!sources.length) throw new Error(`no Objective-C sources in ${source}`);

const run = (command, args) => {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = error.stderr?.toString().trim();
    throw new Error(`${command} ${args.slice(0, 4).join(" ")} failed${stderr ? `:\n${stderr}` : ""}`);
  }
};

const slices = [];
for (const arch of ["x86_64", "arm64"]) {
  const slice = join(source, `.cua-driver-mac12-${arch}`);
  run("/usr/bin/clang", [
    "-fobjc-arc", "-O2", "-target", `${arch}-apple-macos12.3`,
    ...frameworks, ...sources, "-o", slice,
  ]);
  slices.push(slice);
}

try {
  rmSync(output, { force: true });
  run("/usr/bin/lipo", ["-create", ...slices, "-o", output]);
} finally {
  for (const slice of slices) rmSync(slice, { force: true });
}
chmodSync(output, 0o755);

const archs = run("/usr/bin/lipo", ["-archs", output]).trim().split(/\s+/);
for (const arch of ["x86_64", "arm64"]) {
  if (!archs.includes(arch)) throw new Error(`${output} is missing ${arch}: has [${archs.join(" ")}]`);
}

for (const arch of archs) {
  const loadCommands = run("/usr/bin/otool", ["-arch", arch, "-l", output]);
  const match = /LC_BUILD_VERSION[\s\S]*?minos (\d+\.\d+)/.exec(loadCommands);
  if (!match) throw new Error(`${output} does not declare minos for ${arch}`);
  if (Number(match[1]) > 12.3) {
    throw new Error(`${output} ${arch} needs macOS ${match[1]}; the helper must build with -target *-apple-macos12.3`);
  }
  const libraries = run("/usr/bin/otool", ["-arch", arch, "-L", output]);
  if (/libswift/i.test(libraries)) throw new Error(`${output} ${arch} links Swift: the helper must stay Objective-C only`);
}
console.log(`built ${output}: ${archs.join(" + ")}, minos 12.3`);

run("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "runtime", output]);

for (const arch of ["x64", "arm64"]) {
  const directory = join(root, "dist-native", arch, "cua-mac12");
  mkdirSync(directory, { recursive: true });
  copyFileSync(output, join(directory, "cua-driver-mac12"));
  copyFileSync(join(source, "tools.json"), join(directory, "tools.json"));
  console.log(`staged ${join(directory, "cua-driver-mac12")}`);
}

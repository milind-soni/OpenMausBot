import { execFileSync } from "node:child_process";
import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname } from "node:path";

const updateInformation = "gh-releases-zsync|milind-soni|OpenMausBot|latest|OpenMausBot-*-x86_64.AppImage.zsync";

export default async function appImageUpdate(event) {
  if (process.env.OMB_APPIMAGE_UPDATE !== "1" || event.target?.name !== "appImage") return;
  const { file, updateInfo } = event;
  const name = basename(file);
  const version = /^OpenMausBot-([\w.+-]+)-x86_64\.AppImage$/.exec(name)?.[1];
  if (!version) throw new Error(`Unexpected AppImage name: ${name}`);
  const sections = execFileSync("objdump", ["-h", "-j", ".upd_info", "--", file], { encoding: "utf8" });
  const section = /^\s*\d+\s+\.upd_info\s+([0-9a-f]+)\s+[0-9a-f]+\s+[0-9a-f]+\s+([0-9a-f]+)/mi.exec(sections);
  const size = Number.parseInt(section?.[1], 16);
  const offset = Number.parseInt(section?.[2], 16);
  const { size: artifactSize, blockMapSize } = updateInfo ?? {};
  const payloadSize = artifactSize - blockMapSize - 4;
  const info = Buffer.from(`${updateInformation}\0`);
  if (!Number.isSafeInteger(payloadSize) || blockMapSize <= 0 || !Number.isSafeInteger(offset) ||
      size < info.length || size > 4096 || offset < 64 || offset + size > payloadSize) {
    throw new Error("AppImage is missing the update-information section or embedded block map");
  }

  // electron-builder's artifactBuildCompleted hook runs before it writes latest-linux.yml.
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const { appendBlockmap } = builderRequire("app-builder-lib/out/targets/differentialUpdateInfoBuilder.js");
  const artifact = await open(file, "r+");
  try {
    const header = Buffer.alloc(11);
    const footer = Buffer.alloc(4);
    if ((await artifact.stat()).size !== artifactSize || (await artifact.read(header, 0, header.length, 0)).bytesRead !== header.length ||
        !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || !header.subarray(8).equals(Buffer.from([0x41, 0x49, 2])) ||
        (await artifact.read(footer, 0, footer.length, artifactSize - 4)).bytesRead !== footer.length || footer.readUInt32BE() !== blockMapSize) {
      throw new Error("AppImage header or embedded block map does not match the artifact metadata");
    }
    const field = Buffer.alloc(size);
    info.copy(field);
    const { bytesWritten } = await artifact.write(field, 0, field.length, offset);
    if (bytesWritten !== field.length) throw new Error("Could not write the AppImage update-information section");
    await artifact.truncate(payloadSize);
  } finally {
    await artifact.close();
  }
  event.updateInfo = await appendBlockmap(file);
  const url = `https://github.com/milind-soni/OpenMausBot/releases/download/v${version}/${name}`;
  execFileSync("zsyncmake", ["-u", url, "-o", `${name}.zsync`, name], { cwd: dirname(file), stdio: "inherit" });
}

import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const source = new URL("../build/icon.svg", import.meta.url);
const pngPath = new URL("../build/icon-1024.png", import.meta.url);
const icoPath = new URL("../build/icon.ico", import.meta.url);
const electronRuntimePath = new URL("../electron/resources/app-icon.png", import.meta.url);

const png = await sharp(await readFile(source)).resize(1024, 1024).png().toBuffer();
await writeFile(pngPath, png);
await writeFile(electronRuntimePath, png);

// Modern Windows accepts a PNG-compressed image inside an ICO container. This
// tiny wrapper avoids a second bitmap source and keeps the installer icon
// pixel-identical to the SVG used by Linux and the running application.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0); // 0 means 256px in ICO dimensions.
entry.writeUInt8(0, 1);
entry.writeUInt8(0, 2);
entry.writeUInt8(0, 3);
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(header.length + entry.length, 12);
await writeFile(icoPath, Buffer.concat([header, entry, png]));

console.log("Built Agent Centipede PNG, Electron runtime icon, and ICO from build/icon.svg");

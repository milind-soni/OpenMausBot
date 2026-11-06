export type ScreenshotCheck = { ok: boolean; mime: "image/png" | "image/jpeg" };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function structurallyValidPng(bytes: Buffer): boolean {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false;
  let offset = PNG_SIGNATURE.length;
  let hasHeader = false;
  let hasData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = bytes.subarray(offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (pngCrc32(Buffer.concat([type, data])) !== expectedCrc) return false;
    const name = type.toString("ascii");
    if (!hasHeader && name !== "IHDR") return false;
    if (name === "IHDR") {
      if (hasHeader || length !== 13 || data.readUInt32BE(0) === 0 || data.readUInt32BE(4) === 0) return false;
      hasHeader = true;
    } else if (name === "IDAT") {
      if (!hasHeader) return false;
      hasData = true;
    } else if (name === "IEND") {
      return hasHeader && hasData && length === 0 && end === bytes.length;
    }
    offset = end;
  }
  return false;
}

/** Shared with the BYO-VPS backend: a truncated base64 transfer must never
 * become a "successful" preview frame on either transport. */
export function wholeScreenshot(bytes: Buffer): ScreenshotCheck {
  if (bytes.length < 512) return { ok: false, mime: "image/png" };
  const png = structurallyValidPng(bytes);
  if (png) {
    return {
      ok: bytes.subarray(Math.max(0, bytes.length - 12)).includes(Buffer.from("IEND", "ascii")),
      mime: "image/png",
    };
  }
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  return {
    ok: jpeg && bytes.subarray(Math.max(0, bytes.length - 32)).includes(Buffer.from([0xff, 0xd9])),
    mime: "image/jpeg",
  };
}

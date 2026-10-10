import { IMAGE_MAX_BYTES } from "./attachments.ts";

export interface DecodedGeneratedImage {
  bytes: Buffer;
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

const MAX_BASE64_CHARS = Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 8;

function sniffRaster(bytes: Buffer): DecodedGeneratedImage["mime"] | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const head = bytes.subarray(0, 6).toString("ascii");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** Decode an untrusted provider image without trusting its claimed MIME.
 * Codex normally sends raw base64, but accepting a raster data URL makes the
 * boundary resilient to app-server shape changes without widening formats. */
export function decodeGeneratedImage(input: string): DecodedGeneratedImage {
  const trimmed = input.trim();
  const comma = trimmed.startsWith("data:") ? trimmed.indexOf(",") : -1;
  const encoded = comma >= 0 ? trimmed.slice(comma + 1) : trimmed;
  if (!encoded || encoded.length > MAX_BASE64_CHARS || !/^[A-Za-z0-9+/\s]*={0,2}$/.test(encoded)) {
    throw new Error("generated image payload is invalid or too large");
  }
  const compact = encoded.replace(/\s/g, "");
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES) {
    throw new Error(`generated image exceeds ${IMAGE_MAX_BYTES} bytes`);
  }
  const mime = sniffRaster(bytes);
  if (!mime) throw new Error("generated image is not a supported raster format");
  return { bytes, mime };
}

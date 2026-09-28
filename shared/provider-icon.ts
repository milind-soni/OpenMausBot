export const PROVIDER_ICON_PRESETS = [
  "openai", "anthropic", "google", "azure", "aws", "xai", "deepseek",
  "meta", "mistral", "qwen", "moonshot", "cohere", "openrouter",
] as const;

export type ProviderIconPreset = typeof PROVIDER_ICON_PRESETS[number];

export type ProviderIcon =
  | { kind: "preset"; preset: ProviderIconPreset }
  | { kind: "custom"; dataUrl: string };

export const PROVIDER_ICON_MAX_BYTES = 128 * 1024;
export const PROVIDER_ICON_MAX_DIMENSION = 1024;
export const PROVIDER_ICON_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export const PROVIDER_ICON_LABELS: Record<ProviderIconPreset, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  azure: "Microsoft Azure",
  aws: "Amazon Bedrock (AWS)",
  xai: "xAI",
  deepseek: "DeepSeek",
  meta: "Meta",
  mistral: "Mistral AI",
  qwen: "Qwen",
  moonshot: "Moonshot AI",
  cohere: "Cohere",
  openrouter: "OpenRouter",
};

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor(value.length * 3 / 4) - padding;
}

function imageDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
  const u16be = (offset: number) => bytes[offset] * 256 + bytes[offset + 1];
  const u16le = (offset: number) => bytes[offset] + bytes[offset + 1] * 256;
  const u24le = (offset: number) => bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
  const u32le = (offset: number) => bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x10000 + bytes[offset + 3] * 0x1000000;
  const u32be = (offset: number) => bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3];
  if (mime === "image/png") {
    if (bytes.length < 33 || bytes.slice(0, 8).join(",") !== "137,80,78,71,13,10,26,10" ||
        String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR" ||
        bytes.slice(-8).join(",") !== "73,69,78,68,174,66,96,130") return null;
    return { width: u32be(16), height: u32be(20) };
  }
  if (mime === "image/jpeg") {
    if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { height: u16be(offset + 5), width: u16be(offset + 7) };
      }
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = u16be(offset + 2);
      if (length < 2) return null;
      offset += length + 2;
    }
    return null;
  }
  if (bytes.length < 30 || String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" ||
      String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP" || u32le(4) + 8 !== bytes.length) return null;
  const format = String.fromCharCode(...bytes.slice(12, 16));
  if (format === "VP8X") return { width: u24le(24) + 1, height: u24le(27) + 1 };
  if (format === "VP8L" && bytes[20] === 0x2f) {
    const bits = bytes[21] | bytes[22] << 8 | bytes[23] << 16 | bytes[24] << 24;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (format === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
  }
  return null;
}

/** Validate the complete persisted value. Custom images are local data URLs,
 * never remote URLs, and use magic bytes so a forged MIME label is rejected. */
export function providerIconError(icon: ProviderIcon): string | null {
  if (icon.kind === "preset") {
    return (PROVIDER_ICON_PRESETS as readonly string[]).includes(icon.preset)
      ? null : "Choose a supported provider icon.";
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(icon.dataUrl);
  if (!match) return "Upload a PNG, JPEG, or WebP image.";
  const byteLength = decodedBase64Bytes(match[2]);
  if (byteLength > PROVIDER_ICON_MAX_BYTES) {
    return "Provider icons must be 128 KB or smaller.";
  }
  let decoded: string;
  try { decoded = atob(match[2]); } catch { return "The uploaded image is not valid base64."; }
  if (decoded.length !== byteLength) return "The uploaded image is not valid base64.";
  const bytes = Uint8Array.from(decoded, (value) => value.charCodeAt(0));
  const dimensions = imageDimensions(bytes, match[1]);
  if (!dimensions) return "The uploaded image is incomplete or does not match its file type.";
  if (dimensions.width < 1 || dimensions.height < 1 || dimensions.width > PROVIDER_ICON_MAX_DIMENSION ||
      dimensions.height > PROVIDER_ICON_MAX_DIMENSION || dimensions.width * dimensions.height > PROVIDER_ICON_MAX_DIMENSION ** 2) {
    return `Provider icons must be at most ${PROVIDER_ICON_MAX_DIMENSION} × ${PROVIDER_ICON_MAX_DIMENSION} pixels.`;
  }
  return null;
}

/** Backed by a plain ArrayBuffer, which is what WebCrypto takes. */
export type Bytes = Uint8Array<ArrayBuffer>;

const B64U = /^[A-Za-z0-9_-]*$/;

export const utf8 = (text: string): Bytes => new TextEncoder().encode(text);

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function b64u(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict: unpadded URL-safe alphabet only, and canonical (re-encoding gives the same text), so two spellings
 * never mean one value. */
export function fromB64u(text: string): Bytes | null {
  if (!B64U.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return b64u(bytes) === text ? bytes : null;
}

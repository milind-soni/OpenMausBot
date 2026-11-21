/** A file of the Grok Bot app's cache, at the path the app gives it: its slice id as unpadded lowercase base32. */
export const GROK_CACHE = "Library/Application Support/Grok Bot/sand-client-persistence";

export function base32(text: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, value = 0, out = "";
  for (const byte of Buffer.from(text)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return bits ? out + alphabet[(value << (5 - bits)) & 31] : out;
}

export const grokSlice = (kind: string) => `${GROK_CACHE}/${base32(`sand.client.slice.account.user%2E1.${kind}`)}.blob`;

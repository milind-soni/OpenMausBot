// MausBot's chrome as finished pictures, face included: src/assets/mausbot-steel/<body>-<px>.webp, square, framing the
// mascot's whole SVG viewBox, at <px> device pixels. A body with no pictures keeps the drawn steel finish.
const files = import.meta.glob<string>("../assets/mausbot-steel/*.{webp,png}", { eager: true, query: "?url", import: "default" });

export interface SteelImage { body: string; px: number; url: string }

export const STEEL_IMAGES: readonly SteelImage[] = Object.entries(files)
  .flatMap(([path, url]) => {
    const match = /\/([a-z]+)-(\d+)\.(?:webp|png)$/.exec(path);
    return match ? [{ body: match[1]!, px: Number(match[2]), url }] : [];
  })
  .sort((a, b) => a.px - b.px);

/** The smallest image that still has a device pixel for every pixel drawn, or the largest there is; null when this body
 * has none. */
export function steelBodyImage(body: string, size: number, density: number, images: readonly SteelImage[] = STEEL_IMAGES): string | null {
  const own = images.filter((image) => image.body === body);
  if (!own.length) return null;
  const wanted = size * Math.max(1, density);
  return (own.find((image) => image.px >= wanted) ?? own.at(-1)!).url;
}

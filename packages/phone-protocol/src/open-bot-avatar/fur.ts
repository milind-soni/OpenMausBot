/**
 * MausBot: fur on the body. Each style is one SVG filter: noise frays the outline into hair, and
 * the plusher styles shade a soft pile across the body. The face is never filtered.
 *
 * `k` is how many filter units make one viewBox unit: 1 inside an SVG still, the canvas pixels per
 * unit on a canvas, so the fur is the same size on the avatar whatever it is drawn at.
 */
export type Fur = 'fuzzy' | 'fluffy' | 'velvet';

export const FURS: readonly Fur[] = ['fuzzy', 'fluffy', 'velvet'];

const n = (v: number) => (Math.round(v * 1000) / 1000).toString();

/** Frayed edge, as result `d`: noise of this frequency (per viewBox unit) pushes the outline up to `push` units. */
const fray = (k: number, freq: number, octaves: number, seed: number, push: number, input = 'SourceGraphic') =>
  `<feTurbulence type="fractalNoise" baseFrequency="${n(freq / k)}" numOctaves="${octaves}" seed="${seed}" result="n"/>` +
  `<feDisplacementMap in="${input}" in2="n" scale="${n(push * k)}" xChannelSelector="R" yChannelSelector="G" result="d"/>`;

/** A soft pile: lit noise multiplied into the frayed body, `depth` 0..1 of the way from flat to fully shaded. */
const pile = (k: number, freq: number, seed: number, relief: number, depth: number) =>
  `<feTurbulence type="fractalNoise" baseFrequency="${n(freq / k)}" numOctaves="3" seed="${seed}" result="t"/>` +
  `<feDiffuseLighting in="t" surfaceScale="${n(relief * k)}" lighting-color="#ffffff" result="l"><feDistantLight azimuth="235" elevation="62"/></feDiffuseLighting>` +
  `<feComposite in="l" in2="d" operator="arithmetic" k1="${n(depth)}" k2="0" k3="${n(1 - depth * 0.85)}" k4="0" result="lit"/>` +
  `<feComposite in="lit" in2="d" operator="in"/>`;

function primitives(fur: Fur, k: number): string {
  if (fur === 'fuzzy') return fray(k, 1.1, 2, 4, 3.2);
  if (fur === 'fluffy') {
    // Grown a little first, so the tufts reach past the outline instead of eating into it.
    return `<feMorphology in="SourceGraphic" operator="dilate" radius="${n(0.9 * k)}" result="body"/>` + fray(k, 0.75, 2, 3, 6, 'body') + pile(k, 0.6, 8, 0.7, 0.3);
  }
  return fray(k, 1.2, 2, 4, 3) + pile(k, 0.7, 5, 0.9, 0.42);
}

/** The `<filter>` element for a fur style, with room around the body for the hair. */
export function furFilter(fur: Fur, id: string, k = 1): string {
  return `<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">${primitives(fur, k)}</filter>`;
}

export function isFur(value: unknown): value is Fur {
  return (FURS as readonly unknown[]).includes(value);
}

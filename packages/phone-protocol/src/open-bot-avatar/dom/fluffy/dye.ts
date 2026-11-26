/**
 * How a fluffy coat takes its color: one row of colors per dye, from the darkest recess to the
 * brightest lit tip. The shader works out how much light a fiber catches and looks the color up
 * here, so every dye keeps its hue through the same range of shading.
 */
import { oklch, toOklch, type Rgb } from '../../color.ts';

/** Colors in a ramp. */
export const DYE_RAMP_SIZE = 96;
/** Exposure at the bright end of a ramp; 1 is the dye's own color. */
export const DYE_RAMP_RANGE = 2.4;

const ramps = new Map<number, Uint8Array<ArrayBuffer>>();

/** Keep regular lightness steps through the midtones, rolling off near black and white. */
function shoulder(distance: number, room: number): number {
  const knee = room / 2;
  return distance <= knee ? distance : room - knee * Math.exp((knee - distance) / knee);
}

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/**
 * The ramp for a body color, as RGBA bytes. RGB is the color at each exposure. Alpha, the same
 * along the row, is how far the shader replaces it with its separate response for yellow fibers.
 */
export function dyeRamp(rgb: Rgb): Uint8Array<ArrayBuffer> {
  const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
  const cached = ramps.get(key);
  if (cached) return cached;
  const [lightness, chroma, hue] = toOklch(rgb);
  // Amber through lemon keep separate diffuse and glint colors, fading into the shared ramp for
  // neighboring hues, pale creams and dark olives.
  const yellow = (1 - smoothstep(22, 32, Math.abs(hue - 90))) * smoothstep(0.025, 0.085, chroma) * smoothstep(0.54, 0.75, lightness);
  // The dye bounds the brightest tip. Where a channel is already full, the other dyed channels
  // lift more than the weakest one.
  const value = Math.max(...rgb);
  const dye = rgb.map((channel) => (value ? channel / value : 1));
  const weakest = Math.min(...dye);
  const peak = dye.map((channel) => 255 * (channel + (1 - channel) * (0.16 + 0.84 * (channel - weakest)))) as Rgb;
  const [peakLightness] = toOklch(peak);
  // Even black, white and fully saturated primaries need some headroom.
  const mid = Math.max(0.16, Math.min(lightness, peakLightness - 0.025));
  const midChroma = chroma * Math.min(1, mid / Math.max(0.001, lightness));
  const headroom = peakLightness - mid;
  const row = new Uint8Array(DYE_RAMP_SIZE * 4);
  for (let i = 0; i < DYE_RAMP_SIZE; i++) {
    const exposure = ((i + 0.5) * DYE_RAMP_RANGE) / DYE_RAMP_SIZE;
    // At fixed chromaticity, Oklab lightness scales with the cube root of linear light: carry
    // the excursion of a reference dye over to this one.
    const delta = 0.82 * (Math.cbrt(exposure) - 1);
    const L = delta < 0 ? mid - shoulder(-delta, mid) : mid + shoulder(delta, headroom);
    const [r, g, b] = oklch(L, midChroma * Math.min(1, L / mid), hue);
    row.set([Math.round(r), Math.round(g), Math.round(b), Math.round(255 * yellow)], i * 4);
  }
  if (ramps.size >= 64) ramps.delete(ramps.keys().next().value!);
  ramps.set(key, row);
  return row;
}

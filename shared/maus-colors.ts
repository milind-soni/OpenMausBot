// The bot colour palette, shared by the renderer (mascot, mentions) and the
// server (the dynamic cursor drawn into cloud screen frames). Names are the
// `color` values stored on a bot; hexes are the brand swatches.
export const MAUS_COLOR_HEX = {
  green: "#009957",
  blue: "#377FE6",
  red: "#D94B52",
  orange: "#E78531",
  purple: "#8057C8",
  cyan: "#0EA5C6",
  pink: "#D84F8B",
  yellow: "#D8A729",
  teal: "#01A492",
  coral: "#E5634E",
} as const;

export type MausColorName = keyof typeof MAUS_COLOR_HEX;

/** The swatch for a stored bot colour, or undefined for anything else. */
export function mausColorHex(name: string | undefined | null): string | undefined {
  return name && Object.prototype.hasOwnProperty.call(MAUS_COLOR_HEX, name)
    ? MAUS_COLOR_HEX[name as MausColorName]
    : undefined;
}

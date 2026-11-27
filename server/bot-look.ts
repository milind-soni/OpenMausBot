import { DEFAULT_MASCOT_BODY, type MascotBodyId } from "../shared/mascot-bodies.ts";
import { MAUS_COLOR_NAMES, type MausColor } from "../shared/wire.ts";

export const STARTER_COLORS: readonly MausColor[] = MAUS_COLOR_NAMES.filter((color) => color !== "silver" && color !== "chrome");
const ROTATION: readonly MausColor[] = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"];

/** The colour of the bot made `index`-th when nothing else picks one. */
export const rotationColor = (index: number): MausColor => ROTATION[index % ROTATION.length]!;

/** A new bot's first look: always the mascot's own shape, in a random colour no bot here wears yet when one is left. */
export function freshLook(
  bots: ReadonlyArray<{ color: MausColor }>,
  random: () => number = Math.random,
): { color: MausColor; mascotBody: MascotBodyId } {
  const unworn = STARTER_COLORS.filter((color) => !bots.some((bot) => bot.color === color));
  const pool = unworn.length ? unworn : STARTER_COLORS;
  return { color: pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!, mascotBody: DEFAULT_MASCOT_BODY };
}

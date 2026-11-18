/**
 * What a carved body is made of, shared by every festival pack the generator bakes.
 *
 * Loaded by `node --experimental-strip-types`, so only erasable type syntax.
 */

import type { Field } from "./draw.ts"

export const GREY = "#3d3d3d"
export const LIGHT_GREY = "#8d8d8d"
export const INK = "#0d0a10"

/** "body" is the bot's paint, "accent" the bot's colour, anything else a literal hex colour. */
export type Fill = "body" | "accent" | string

export interface Eyes {
  /** Rest position of the pair's centre, in drawing units. */
  cx: number
  cy: number
  /** Half the distance between the two eyes. */
  dx: number
  /** Resting pill size. */
  w: number
  h: number
  /** Diameter when startled. */
  round: number
  ink: string
  /** False when the drawing carries its own mouth (the skull's teeth). */
  mouth: boolean
  mouthInk: string
  /** Where the smile sits when it can't hang under the eyes (the mummy's slit). */
  mouthY: number | null
}

export interface Def {
  id: string
  name: string
  paint: "bot" | "pale" | "bone"
  bone: string | null
  face: Field
  eyes: Omit<Eyes, "mouth" | "mouthInk" | "mouthY"> & Partial<Pick<Eyes, "mouth" | "mouthInk" | "mouthY">>
  parts: Array<[Field, Fill]>
}

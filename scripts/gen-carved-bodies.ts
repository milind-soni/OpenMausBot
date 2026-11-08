/**
 * Bakes every festival pack into `shared/carved-bodies.ts`. Run with `pnpm gen:carved`.
 *
 * Each pack's drawings live in `scripts/mascot-bodies/<pack>.ts`, in a 240-unit square
 * centred on x = 120.
 *
 * Loaded by `node --experimental-strip-types`, so only erasable type syntax.
 */

import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { toPath } from "./mascot-bodies/draw.ts"
import type { Def, Eyes, Fill } from "./mascot-bodies/carved.ts"
import { DIWALI } from "./mascot-bodies/diwali.ts"
import { HALLOWEEN } from "./mascot-bodies/halloween.ts"

/** Picker order: each pack's ids, in its drawing order. */
const PACKS: ReadonlyArray<[string, Def[]]> = [["halloween", HALLOWEEN], ["diwali", DIWALI]]
const DEFS = PACKS.flatMap(([, defs]) => defs)

const quote = (s: string) => JSON.stringify(s)

interface Baked {
  id: string
  name: string
  paint: Def["paint"]
  bone: string | null
  eyes: Eyes
  clip: string
  parts: Array<{ fill: Fill; d: string }>
}

const BAKED: Baked[] = DEFS.map((def) => ({
  id: def.id,
  name: def.name,
  paint: def.paint,
  bone: def.bone,
  eyes: { ...def.eyes, mouth: def.eyes.mouth ?? true, mouthInk: def.eyes.mouthInk ?? def.eyes.ink, mouthY: def.eyes.mouthY ?? null },
  clip: toPath(def.face),
  parts: def.parts.map(([field, fill]) => ({ fill, d: toPath(field) })),
}))

/** Long path data on several lines; both phone parsers read newlines as separators. */
function wrap(d: string, pad: string, width = 100): string {
  const lines: string[] = []
  let line = ""
  for (const token of d.split(" ")) {
    if (line && line.length + 1 + token.length > width) {
      lines.push(pad + line)
      line = token
    } else line = line ? `${line} ${token}` : token
  }
  if (line) lines.push(pad + line)
  return lines.join("\n")
}

function emitTs(): string {
  const entries = BAKED.map((body) => {
    const parts = body.parts.map((part) => `      { fill: ${quote(part.fill)}, d: ${quote(part.d)} },`)
    return [
      `  ${body.id}: {`,
      `    id: ${quote(body.id)},`,
      `    name: ${quote(body.name)},`,
      `    paint: ${quote(body.paint)},`,
      `    bone: ${body.bone ? quote(body.bone) : "null"},`,
      `    eyes: ${JSON.stringify(body.eyes).replace(/"(\w+)":/g, "$1: ").replace(/,(?=\w)/g, ", ")},`,
      `    clip: ${quote(body.clip)},`,
      `    parts: [`,
      ...parts,
      `    ],`,
      `  },`,
    ].join("\n")
  })
  const packs = PACKS.map(([pack, defs]) => {
    const upper = pack.toUpperCase()
    const type = pack[0].toUpperCase() + pack.slice(1)
    return [
      `/** Every ${type} body id, in the order the picker shows them. */`,
      `export const ${upper}_BODY_IDS = [${defs.map((def) => quote(def.id)).join(", ")}] as const;`,
      ``,
      `export type ${type}BodyId = (typeof ${upper}_BODY_IDS)[number];`,
    ].join("\n")
  })
  const all = PACKS.map(([pack]) => `...${pack.toUpperCase()}_BODY_IDS`).join(", ")
  return `/**
 * The festival bodies a bot can wear, drawn flat with a carved face.
 *
 * GENERATED FILE — do not hand-edit. Run \`pnpm gen:carved\` to rebuild it from
 * \`scripts/gen-carved-bodies.ts\`.
 *
 * Drawn flat: the bot's own colour (or a pale or fixed stand-in), a few fixed-colour accents
 * and a carved face. Paths are in a 240-unit square centred on x = 120.
 */

${packs.join("\n\n")}

export const CARVED_BODY_IDS = [${all}] as const;

export type CarvedBodyId = (typeof CARVED_BODY_IDS)[number];

export interface CarvedEyes {
  /** Rest position of the pair's centre. */
  cx: number;
  cy: number;
  /** Half the distance between the two eyes. */
  dx: number;
  /** Resting pill size. */
  w: number;
  h: number;
  /** Diameter when startled. */
  round: number;
  ink: string;
  /** False when the drawing carries its own mouth. */
  mouth: boolean;
  mouthInk: string;
  /** Where the smile sits when it can't hang under the eyes. */
  mouthY: number | null;
}

export interface CarvedBody {
  id: CarvedBodyId;
  /** Human-readable name, used for the picker and the accessible label. */
  name: string;
  /** "bot" fills with the bot's colour, "pale" with a near-white tint of it, "bone" with \`bone\`. */
  paint: "bot" | "pale" | "bone";
  bone: string | null;
  eyes: CarvedEyes;
  /** Where the eyes may show. */
  clip: string;
  /** Draw order, bottom first. "body" is the paint; "accent" is the bot's colour. */
  parts: ReadonlyArray<{ fill: string; d: string }>;
}

export const CARVED_BODIES: Record<CarvedBodyId, CarvedBody> = {
${entries.join("\n")}
};
`
}

const swiftNumber = (n: number | null) => (n === null ? "nil" : String(n))

function emitSwift(): string {
  const entries = BAKED.map((body) => {
    const e = body.eyes
    const parts = body.parts.map((part) => [
      `                Part(fill: ${quote(part.fill)}, path: """`,
      wrap(part.d, "                "),
      `                """),`,
    ].join("\n"))
    return [
      `        ${quote(body.id)}: Body(`,
      `            id: ${quote(body.id)},`,
      `            name: ${quote(body.name)},`,
      `            paint: ${quote(body.paint)},`,
      `            bone: ${body.bone ? quote(body.bone) : "nil"},`,
      `            eyes: Eyes(cx: ${e.cx}, cy: ${e.cy}, dx: ${e.dx}, w: ${e.w}, h: ${e.h}, round: ${e.round}, ink: ${quote(e.ink)}, mouth: ${e.mouth}, mouthInk: ${quote(e.mouthInk)}, mouthY: ${swiftNumber(e.mouthY)}),`,
      `            clip: """`,
      wrap(body.clip, "            "),
      `            """,`,
      `            parts: [`,
      ...parts,
      `            ]`,
      `        ),`,
    ].join("\n")
  })
  return `// The festival bodies a bot can wear — the phone's half of \`shared/carved-bodies.ts\`.
//
// GENERATED FILE — do not hand-edit. Run \`pnpm gen:carved --swift <file>\` to rebuild it
// from \`scripts/gen-carved-bodies.ts\`.
//
// Paths are absolute \`M\`, \`C\`, \`Z\` only, in a 240-unit square centred on x = 120, with
// newlines as separators — what \`MausSilhouette.parse\` reads.
import CoreGraphics

enum CarvedBodies {
    struct Eyes {
        let cx: CGFloat
        let cy: CGFloat
        let dx: CGFloat
        let w: CGFloat
        let h: CGFloat
        let round: CGFloat
        let ink: String
        let mouth: Bool
        let mouthInk: String
        let mouthY: CGFloat?
    }

    /// \`fill\` is "body" (the bot's paint), "accent" (the bot's colour) or a literal hex colour.
    struct Part {
        let fill: String
        let path: String
    }

    struct Body {
        let id: String
        let name: String
        /// "bot", "pale" or "bone".
        let paint: String
        let bone: String?
        let eyes: Eyes
        let clip: String
        let parts: [Part]
    }

${PACKS.map(([pack, defs]) => `    static let ${pack}: [String] = [${defs.map((def) => quote(def.id)).join(", ")}]`).join("\n")}

    static let all: [String: Body] = [
${entries.join("\n")}
    ]

    static func body(_ id: String?) -> Body? {
        guard let id else { return nil }
        return all[id]
    }
}
`
}

const kotlinFloat = (n: number) => `${n}f`

function emitKotlin(): string {
  const entries = BAKED.map((body) => {
    const e = body.eyes
    const parts = body.parts.map((part) => [
      `                Part(fill = ${quote(part.fill)}, path = """`,
      wrap(part.d, "                "),
      `                """),`,
    ].join("\n"))
    return [
      `        ${quote(body.id)} to Body(`,
      `            id = ${quote(body.id)},`,
      `            name = ${quote(body.name)},`,
      `            paint = ${quote(body.paint)},`,
      `            bone = ${body.bone ? quote(body.bone) : "null"},`,
      `            eyes = Eyes(cx = ${kotlinFloat(e.cx)}, cy = ${kotlinFloat(e.cy)}, dx = ${kotlinFloat(e.dx)}, w = ${kotlinFloat(e.w)}, h = ${kotlinFloat(e.h)}, round = ${kotlinFloat(e.round)}, ink = ${quote(e.ink)}, mouth = ${e.mouth}, mouthInk = ${quote(e.mouthInk)}, mouthY = ${e.mouthY === null ? "null" : kotlinFloat(e.mouthY)}),`,
      `            clip = """`,
      wrap(body.clip, "            "),
      `            """,`,
      `            parts = listOf(`,
      ...parts,
      `            ),`,
      `        ),`,
    ].join("\n")
  })
  return `package com.openmausbot.companion.ui

/**
 * The festival bodies a bot can wear — the Android half of \`shared/carved-bodies.ts\`.
 *
 * GENERATED FILE — do not hand-edit. Run \`pnpm gen:carved --kotlin <file>\` to rebuild it
 * from \`scripts/gen-carved-bodies.ts\`.
 *
 * Paths are absolute \`M\`, \`C\`, \`Z\` only, in a 240-unit square centred on x = 120, with
 * newlines as separators — what [MausSilhouette] parses.
 */
internal object CarvedBodies {
    data class Eyes(
        val cx: Float,
        val cy: Float,
        val dx: Float,
        val w: Float,
        val h: Float,
        val round: Float,
        val ink: String,
        val mouth: Boolean,
        val mouthInk: String,
        val mouthY: Float?,
    )

    /** [fill] is "body" (the bot's paint), "accent" (the bot's colour) or a literal hex colour. */
    data class Part(val fill: String, val path: String)

    data class Body(
        val id: String,
        val name: String,
        /** "bot", "pale" or "bone". */
        val paint: String,
        val bone: String?,
        val eyes: Eyes,
        val clip: String,
        val parts: List<Part>,
    )

${PACKS.map(([pack, defs]) => `    val ${pack}: List<String> = listOf(${defs.map((def) => quote(def.id)).join(", ")})`).join("\n")}

    val all: Map<String, Body> = mapOf(
${entries.join("\n")}
    )

    fun body(id: String?): Body? = id?.let { all[it] }
}
`
}

const out = fileURLToPath(new URL("../shared/carved-bodies.ts", import.meta.url))
writeFileSync(out, emitTs())
console.log(`wrote ${BAKED.length} carved bodies to shared/carved-bodies.ts`)

for (const [flag, emitNative] of [["--swift", emitSwift], ["--kotlin", emitKotlin]] as const) {
  const at = process.argv.indexOf(flag)
  if (at === -1) continue
  const nativeOut = process.argv[at + 1]
  if (!nativeOut) throw new Error(`${flag} needs an output file`)
  writeFileSync(nativeOut, emitNative())
  console.log(`wrote ${nativeOut}`)
}

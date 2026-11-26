/**
 * The Diwali pack: five firecrackers (rocket, anaar, chakri, sparkler, bomb) in the bot's
 * colour, and five sweets and snacks (laddu, chakli, jalebi, kaju katli, karanji) in their
 * own colours.
 *
 * Every drawing lives in a 240-unit square centred on x = 120.
 *
 * Loaded by `node --experimental-strip-types`, so only erasable type syntax.
 */

import { box, circle, ellipse, grow, intersect, polygon, polyStroke, smooth, stroke, subtract, union, type Field } from "./draw.ts"
import { GREY, INK, LIGHT_GREY, type Def } from "./carved.ts"

const GOLD = "#ffc93c"
const HOT = "#fff3c4"
const PAPER = "#fff3dc"

type Point = [number, number]
const TAU = Math.PI * 2
const polar = (cx: number, cy: number, r: number, a: number): Point => [cx + r * Math.sin(a), cy - r * Math.cos(a)]
const around = <T>(n: number, fn: (a: number, i: number) => T, offset = 0): T[] =>
  Array.from({ length: n }, (_, i) => fn(offset + (TAU * i) / n, i))

/** A four-point twinkle, the spark every firecracker throws. */
const twinkle = (cx: number, cy: number, r: number): Field =>
  smooth(2, polyStroke([[cx, cy - r, 0.6], [cx, cy, r * 0.28], [cx, cy + r, 0.6]]), polyStroke([[cx - r, cy, 0.6], [cx, cy, r * 0.28], [cx + r, cy, 0.6]]))

/**
 * An Archimedean band of half-width `width` from radius r0 to r1 over `turns` turns, measured
 * radially: at these pitches that is within a few percent of the true distance, and one
 * evaluation costs a few turns instead of hundreds of stroke segments.
 */
function spiral(cx: number, cy: number, r0: number, r1: number, turns: number, width: number, start = 0): Field {
  const span = turns * TAU
  const [ax, ay] = polar(cx, cy, r0, start)
  const [bx, by] = polar(cx, cy, r1, start + span)
  return (x, y) => {
    const rho = Math.hypot(x - cx, y - cy)
    const phi = Math.atan2(x - cx, cy - y)
    let best = Math.min(Math.hypot(x - ax, y - ay), Math.hypot(x - bx, y - by))
    for (let k = Math.ceil((start - phi) / TAU); phi + k * TAU <= start + span; k++) {
      const t = (phi + k * TAU - start) / span
      best = Math.min(best, Math.abs(rho - (r0 + (r1 - r0) * t)))
    }
    return best - width
  }
}

const rocketTube = box(74, 92, 166, 206, 14)
const rocketCone = grow(polygon([[78, 96], [162, 96], [120, 20]]), 6)
const rocketBand = intersect(rocketTube, box(0, 178, 240, 192))
const rocketStick = polyStroke([[120, 200, 5], [120, 248, 4]])
const rocketSparks = union(twinkle(84, 228, 14), twinkle(158, 234, 10))

const anaarPot = grow(polygon([[46, 230], [194, 230], [152, 104], [88, 104]]), 7)
const anaarBand = intersect(anaarPot, box(0, 118, 240, 132))
const anaarCap = box(98, 86, 142, 106, 7)
const anaarPlume = smooth(4, ...[-0.62, -0.31, 0, 0.31, 0.62].map((a, i) => {
  const [x, y] = polar(120, 90, i === 2 ? 82 : 70, a)
  return polyStroke([[120, 86, 7], [x, y, 2.5]])
}))
const anaarCore = smooth(3, ellipse(120, 62, 9, 26), circle(120, 84, 8))
const anaarSparks = union(twinkle(56, 34, 11), twinkle(184, 34, 11), twinkle(120, 6, 9))

const chakri = circle(120, 132, 86)
const chakriCoil = spiral(120, 132, 82, 60, 1.25, 2.6, 0.4)
const chakriTrails = union(...around(6, (a) => {
  const p0 = polar(120, 132, 80, a)
  const p1 = polar(120, 132, 98, a + 0.18)
  const p2 = polar(120, 132, 108, a + 0.42)
  const p3 = polar(120, 132, 110, a + 0.62)
  return stroke(p0, p1, p2, p3, 7, 1.5, 16)
}))

const sparkler = circle(120, 108, 62)
const sparklerRays = union(...around(12, (a, i) => {
  const [x0, y0] = polar(120, 108, 76, a)
  const [x1, y1] = polar(120, 108, i % 2 ? 96 : 110, a)
  return polyStroke([[x0, y0, 5.5], [x1, y1, 2]])
}, TAU / 24))
const sparklerTwinkles = union(twinkle(28, 34, 12), twinkle(214, 58, 10), twinkle(36, 170, 9))
const sparklerWire = polyStroke([[120, 160, 4.5], [120, 246, 4]])

const bomb = circle(120, 148, 86)
const bombCollar = grow(polygon([[134, 44], [166, 60], [156, 80], [124, 64]]), 4)
const bombFuse = stroke([152, 52], [160, 28], [184, 40], [192, 18], 4.5, 3.5)
const bombSpark = twinkle(196, 12, 18)
const bombSparkCore = circle(196, 12, 6)

const LADDU = "#f6a420"
const laddu = smooth(2, circle(120, 140, 90), ...around(34, (a) => circle(...polar(120, 140, 89, a), 6.5)))
const boondi: Point[] = []
for (let row = -5; row <= 5; row++) {
  for (let col = -5; col <= 5; col++) {
    const x = 120 + (col + (row % 2 ? 0.5 : 0)) * 17
    const y = 140 + row * 15
    if (Math.hypot(x - 120, y - 140) < 78) boondi.push([x + ((row * 7 + col * 3) % 5) - 2, y + ((row * 3 + col * 5) % 5) - 2])
  }
}
const ladduBoondi = union(...boondi.map(([x, y]) => circle(x, y, 4.2)))

const CHAKLI = "#cf8f45"
const chakli = subtract(circle(120, 134, 92), union(...around(26, (a) => circle(...polar(120, 134, 95, a), 6.5))), 2)
const chakliGroove = spiral(120, 134, 18, 84, 2.6, 3.2, 2.2)

const JALEBI = "#f7941d"
const jalebiCoil = spiral(120, 134, 10, 86, 2.25, 15, 0)
const jalebi = smooth(4, jalebiCoil, circle(120, 134, 28))
const jalebiSyrup = circle(120, 134, 88)
const jalebiShine = intersect(grow(jalebiCoil, -9), box(0, 0, 240, 118))

const KATLI = "#f2e4c6"
const katliTop = grow(polygon([[120, 26], [218, 124], [120, 222], [22, 124]]), 8)
const katliEdge = grow(polygon([[120, 40], [218, 138], [120, 236], [22, 138]]), 8)
const katliVark = intersect(grow(katliTop, -10), union(ellipse(70, 116, 22, 12), ellipse(170, 132, 20, 11), ellipse(122, 60, 18, 10), ellipse(124, 196, 16, 9)))

const KARANJI = "#ecb460"
const karanjiDome = intersect(ellipse(120, 200, 112, 128), box(0, 0, 240, 206, 0))
const crimpAt = (a: number, f: number): Point => [120 + 112 * f * Math.sin(a), 200 - 128 * f * Math.cos(a)]
const CRIMPS = Array.from({ length: 17 }, (_, i) => -1.42 + (2.84 * i) / 16)
const karanji = smooth(3, karanjiDome, ...CRIMPS.map((a) => circle(...crimpAt(a, 0.98), 9)))
const karanjiSeam = intersect(subtract(grow(karanjiDome, -15), grow(karanjiDome, -19.5)), box(0, 0, 240, 192))

export const DIWALI: Def[] = [
  {
    id: "rocket", name: "Rocket", paint: "bot", bone: null, face: rocketTube,
    eyes: { cx: 120, cy: 136, dx: 24, w: 20, h: 38, round: 34, ink: INK },
    parts: [[rocketStick, LIGHT_GREY], [rocketSparks, GOLD], [rocketTube, "body"], [rocketBand, PAPER], [rocketCone, GREY]],
  },
  {
    id: "anaar", name: "Anaar", paint: "bot", bone: null, face: anaarPot,
    eyes: { cx: 120, cy: 170, dx: 26, w: 22, h: 40, round: 36, ink: INK },
    parts: [[anaarPlume, GOLD], [anaarCore, HOT], [anaarSparks, GOLD], [anaarPot, "body"], [anaarBand, PAPER], [anaarCap, GREY]],
  },
  {
    id: "chakri", name: "Chakri", paint: "bot", bone: null, face: chakri,
    eyes: { cx: 120, cy: 126, dx: 24, w: 20, h: 38, round: 34, ink: INK },
    parts: [[chakriTrails, GOLD], [chakri, "body"], [chakriCoil, GREY]],
  },
  {
    id: "sparkler", name: "Sparkler", paint: "bot", bone: null, face: sparkler,
    eyes: { cx: 120, cy: 104, dx: 24, w: 21, h: 40, round: 36, ink: INK },
    parts: [[sparklerWire, LIGHT_GREY], [sparklerRays, GOLD], [sparklerTwinkles, GOLD], [sparkler, "body"]],
  },
  {
    id: "bomb", name: "Bomb", paint: "bot", bone: null, face: bomb,
    eyes: { cx: 120, cy: 150, dx: 34, w: 26, h: 50, round: 44, ink: INK },
    parts: [[bombFuse, "#b08a5a"], [bombCollar, GREY], [bomb, "body"], [bombSpark, GOLD], [bombSparkCore, HOT]],
  },
  {
    id: "laddu", name: "Laddu", paint: "bone", bone: LADDU, face: laddu,
    eyes: { cx: 120, cy: 138, dx: 34, w: 26, h: 50, round: 44, ink: INK },
    parts: [[laddu, "body"], [ladduBoondi, "#ffc560"]],
  },
  {
    id: "chakli", name: "Chakli", paint: "bone", bone: CHAKLI, face: chakli,
    eyes: { cx: 120, cy: 128, dx: 30, w: 24, h: 46, round: 40, ink: INK },
    parts: [[chakli, "body"], [chakliGroove, "#a8692b"]],
  },
  {
    id: "jalebi", name: "Jalebi", paint: "bone", bone: JALEBI, face: jalebiSyrup,
    eyes: { cx: 120, cy: 128, dx: 30, w: 24, h: 46, round: 40, ink: INK },
    parts: [[intersect(jalebiSyrup, grow(jalebi, 4)), "#c9650c"], [jalebi, "body"], [jalebiShine, "#ffc566"]],
  },
  {
    id: "katli", name: "Kaju katli", paint: "bone", bone: KATLI, face: katliTop,
    eyes: { cx: 120, cy: 122, dx: 30, w: 24, h: 46, round: 40, ink: INK },
    parts: [[katliEdge, "#d9c39a"], [katliTop, "body"], [katliVark, "#cdd3db"]],
  },
  {
    id: "karanji", name: "Karanji", paint: "bone", bone: KARANJI, face: karanjiDome,
    eyes: { cx: 120, cy: 150, dx: 30, w: 24, h: 44, round: 40, ink: INK },
    parts: [[karanji, "body"], [karanjiSeam, "#cf923d"]],
  },
]


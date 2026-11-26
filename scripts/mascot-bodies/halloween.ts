/**
 * The Halloween pack: pumpkin, ghost, witch, bat, cat, skull, monster, mummy, vampire, spider.
 *
 * Every drawing lives in a 240-unit square centred on x = 120.
 *
 * Loaded by `node --experimental-strip-types`, so only erasable type syntax.
 */

import { box, circle, ellipse, grow, intersect, mirror, polygon, polyStroke, smooth, stroke, subtract, union } from "./draw.ts"
import { GREY, INK, LIGHT_GREY, type Def } from "./carved.ts"

const NUT_GREY = "#6f6f6f"

const pFront = union(ellipse(97, 146, 64, 92), ellipse(143, 146, 64, 92))
const pSide = union(ellipse(53, 154, 46, 70), ellipse(187, 154, 46, 70))
const pumpkin = smooth(6, pFront, pSide)
const pumpkinStem = smooth(3, stroke([121, 74], [123, 46], [114, 24], [97, 11], 12, 7.5), circle(121, 74, 12))

const ghost = subtract(
  smooth(6, circle(120, 98, 80), polygon([[40, 98], [200, 98], [208, 196], [32, 196]]), ...[54, 98, 142, 186].map((x) => circle(x, 198, 22))),
  union(...[76, 120, 164].map((x) => circle(x, 228, 12))),
  3,
)

const witchHair = smooth(5, box(44, 100, 196, 170, 36), mirror(stroke([60, 112], [46, 140], [40, 184], [50, 224], 19, 8, 50)))
const witchHead = ellipse(120, 168, 76, 70)
const witchBrim = ellipse(120, 98, 112, 16)
const witchCone = stroke([120, 94], [117, 56], [138, 30], [184, 14], 44, 3.5, 60)
const witchBand = intersect(witchCone, box(0, 72, 240, 88))
const witchFace = subtract(witchHead, grow(witchBrim, 3))

const batWing = subtract(
  polygon([[150, 106], [196, 74], [244, 58], [238, 120], [204, 158], [162, 168]]),
  union(circle(258, 91, 28), circle(234, 149, 28), circle(188, 180, 28)),
  3,
)
const bat = smooth(8, circle(120, 136, 72), mirror(batWing), mirror(grow(polygon([[74, 100], [80, 32], [114, 78]]), 4)))

const cat = smooth(8, ellipse(120, 150, 98, 80), mirror(grow(polygon([[34, 120], [50, 30], [102, 78]]), 5)))

const skull = subtract(smooth(10, circle(120, 100, 84), box(66, 146, 174, 228, 22)), mirror(circle(34, 202, 32)), 8)
const skullNose = grow(polygon([[110, 152], [130, 152], [120, 168]]), 3)
const skullTeeth = intersect(grow(skull, -1), union(
  polyStroke([[82, 202, 2.2], [158, 202, 2.2]]),
  ...[95, 107.5, 120, 132.5, 145].map((x) => polyStroke([[x, 190, 2.2], [x, 214, 2.2]])),
))

const monHead = box(34, 22, 206, 232, 26)
const zigzag: Array<[number, number]> = []
for (let i = 6; i >= 0; i--) {
  const x = 34 + (172 / 6) * i
  zigzag.push([x, 80])
  if (i > 0) zigzag.push([x - 172 / 12, 98])
}
const monHair = intersect(grow(monHead, 4), grow(polygon([[30, 10], [210, 10], [210, 80], ...zigzag, [30, 80]]), 1.5))
const monBolt = mirror(box(12, 180, 44, 198, 4))
const monNut = mirror(box(4, 174, 18, 204, 3.5))
const monFace = subtract(monHead, grow(monHair, 2))

const mummy = box(36, 14, 204, 232, 84)
const wraps: Array<[number, number]> = [[44, -0.12], [74, 0.1], [158, 0.12], [188, -0.1], [216, 0.08]]
const mummyWraps = intersect(mummy, union(...wraps.map(([y, m]) => polyStroke([[-10, y - m * 130, 2], [250, y + m * 130, 2]]))))
const mummySlit = intersect(grow(mummy, -0.5), polygon([[-10, 104], [250, 96], [250, 134], [-10, 142]]))

const vampCollar = grow(polygon([[24, 110], [76, 178], [120, 190], [164, 178], [216, 110], [212, 198], [176, 232], [120, 244], [64, 232], [28, 198]]), 2)
const vampLining = intersect(grow(vampCollar, -8), box(0, 100, 240, 236))
const vampHead = ellipse(120, 136, 74, 90)
const vampHair = intersect(grow(vampHead, 4), polygon([[0, 0], [240, 0], [240, 112], [198, 108], [178, 80], [148, 72], [120, 104], [92, 72], [62, 80], [42, 108], [0, 112]]))
const vampFace = subtract(vampHead, grow(vampHair, 2))

const legs: Array<Array<[number, number, number]>> = [
  [[174, 102, 6.5], [212, 62, 6], [236, 86, 5]],
  [[188, 124, 6.5], [228, 106, 6], [240, 134, 5]],
  [[188, 152, 6.5], [228, 154, 6], [236, 188, 5]],
  [[176, 178, 6.5], [208, 202, 6], [214, 234, 5]],
]
const spider = circle(120, 138, 74)

export const HALLOWEEN: Def[] = [
  {
    id: "pumpkin", name: "Pumpkin", paint: "bot", bone: null, face: pumpkin,
    eyes: { cx: 120, cy: 152, dx: 35, w: 28, h: 56, round: 50, ink: INK },
    parts: [[pumpkinStem, GREY], [pumpkin, "body"]],
  },
  {
    id: "ghost", name: "Ghost", paint: "pale", bone: null, face: ghost,
    eyes: { cx: 120, cy: 112, dx: 32, w: 26, h: 52, round: 44, ink: INK },
    parts: [[ghost, "body"]],
  },
  {
    id: "witch", name: "Witch", paint: "bot", bone: null, face: witchFace,
    eyes: { cx: 120, cy: 174, dx: 30, w: 24, h: 46, round: 40, ink: INK },
    parts: [[witchHair, GREY], [witchHead, "body"], [witchCone, GREY], [witchBand, "accent"], [witchBrim, GREY]],
  },
  {
    id: "bat", name: "Bat", paint: "bot", bone: null, face: bat,
    eyes: { cx: 120, cy: 142, dx: 28, w: 24, h: 46, round: 40, ink: INK },
    parts: [[bat, "body"]],
  },
  {
    id: "cat", name: "Cat", paint: "bot", bone: null, face: cat,
    eyes: { cx: 120, cy: 156, dx: 36, w: 27, h: 52, round: 46, ink: INK },
    parts: [[cat, "body"]],
  },
  {
    id: "skull", name: "Skull", paint: "bone", bone: "#f1ede6", face: skull,
    eyes: { cx: 120, cy: 112, dx: 34, w: 42, h: 44, round: 50, ink: INK, mouth: false },
    parts: [[skull, "body"], [skullNose, INK], [skullTeeth, INK]],
  },
  {
    id: "monster", name: "Monster", paint: "bot", bone: null, face: monFace,
    eyes: { cx: 120, cy: 156, dx: 36, w: 27, h: 52, round: 46, ink: INK },
    parts: [[monBolt, LIGHT_GREY], [monNut, NUT_GREY], [monHead, "body"], [monHair, GREY]],
  },
  {
    id: "mummy", name: "Mummy", paint: "bone", bone: "#efe5cf", face: mummySlit,
    eyes: { cx: 120, cy: 119, dx: 30, w: 24, h: 24, round: 30, ink: "#f4efe4", mouthInk: INK, mouthY: 170 },
    parts: [[mummy, "body"], [mummyWraps, "#d8ccb2"], [mummySlit, INK]],
  },
  {
    id: "vampire", name: "Vampire", paint: "bot", bone: null, face: vampFace,
    eyes: { cx: 120, cy: 150, dx: 28, w: 22, h: 42, round: 38, ink: "#7a0f24" },
    parts: [[vampCollar, GREY], [vampLining, "accent"], [vampHead, "#f2eef4"], [vampHair, GREY]],
  },
  {
    id: "spider", name: "Spider", paint: "bot", bone: null, face: spider,
    eyes: { cx: 120, cy: 142, dx: 28, w: 24, h: 46, round: 40, ink: INK },
    parts: [
      [polyStroke([[120, 66, 1.3], [120, 0, 1.3]]), LIGHT_GREY],
      [mirror(union(...legs.map((leg) => polyStroke(leg)))), GREY],
      [spider, "body"],
    ],
  },
]

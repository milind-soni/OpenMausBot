/**
 * Open Bot Avatar's avatars, worn as bodies: its seven starters, then its gallery. MIT, Copyright (c) 2026
 * Dominik Scholz. Ids carry "obj-" so they never meet a shape or festival body's.
 */

import type { MascotBodyId } from "./mascot-bodies.ts";
import { examples } from "./open-bot-avatar/examples.ts";
import type { AvatarDefinition } from "./open-bot-avatar/types.ts";

/** In the order the look pickers show them. */
export const OBJECT_BODY_IDS = [
  "obj-controller", "obj-barbell", "obj-mug", "obj-lightbulb", "obj-chat", "obj-sprout",
  "obj-watering-can", "obj-book", "obj-brain", "obj-bull", "obj-bunny", "obj-camera",
  "obj-cat", "obj-cloud", "obj-egg", "obj-ghost", "obj-magnifier", "obj-paint-brush",
  "obj-palette", "obj-rocket", "obj-witch-hat",
] as const;

export type ObjectBodyId = (typeof OBJECT_BODY_IDS)[number];

const GALLERY: AvatarDefinition[] = [
  {
    version: 1,
    id: "book",
    name: "Book",
    body: { path: "M12 32C12 29 14 27 17 26C30 21.5 42 23 50 31C58 23 70 21.5 83 26C86 27 88 29 88 32V64H89C90.7 64 92 65.3 92 67V75C92 77 90.5 78 88.5 77.5C76 75 60 76 50 84C40 76 24 75 11.5 77.5C9.5 78 8 77 8 75V67C8 65.3 9.3 64 11 64H12Z" },
    eyes: { x: 50, y: 51, spacing: 18, scale: 1.1 },
  },
  {
    version: 1,
    id: "brain",
    name: "Brain",
    body: { path: "M14 50C10 42 14 32 22 30C24 21 34 17 41 21C46 15 56 15 61 20C68 16 78 20 79 28C87 30 91 39 88 47C92 54 89 64 81 66C80 71 76 74 71 73C67 75 64 74 62 72C61 74 61 76 61.5 78C62 81 59 82.5 57 81.5C55.5 80.5 55 78 54 76C53 74 50 72.5 47 72.5C42 74 38 72 36 70C30 73 20 71 18 64C12 62 10 56 14 50Z" },
    eyes: { x: 50, y: 45, spacing: 17, scale: 1.15 },
  },
  {
    version: 1,
    id: "bull",
    name: "Bull",
    body: { path: "M40 28L60 28C70 28 76 36 76 48L76 62C76 74 66 84 50 84C34 84 24 74 24 62L24 48C24 36 30 28 40 28ZM32 40C22 38 15 32 15 24C15 18 18 13 22 10C25 8 28 10 27 13C25 18 24 22 28 26C31 29 36 30 42 30ZM58 30C64 30 69 29 72 26C76 22 75 18 73 13C72 10 75 8 78 10C82 13 85 18 85 24C85 32 78 38 68 40ZM29 55C23 56 17 55 12 52C9 50 8 47 10 45C14 41 22 40 28 42ZM72 42C78 40 86 41 90 45C92 47 91 50 88 52C83 55 77 56 71 55Z" },
    eyes: { x: 50, y: 52, spacing: 17, scale: 1.15 },
  },
  {
    version: 1,
    id: "bunny",
    name: "Bunny",
    body: { path: "M50 40C68 40 80 50 80 64C80 78 68 86 50 86C32 86 20 78 20 64C20 50 32 40 50 40ZM30 46C26 36 24 24 26 16C28 10 34 10 37 15C40 22 42 34 42 44ZM58 44C58 34 61 22 66 15C69 10 76 11 76 17C76 25 74 36 70 46Z" },
    eyes: { x: 50, y: 62, spacing: 17, scale: 1.15 },
  },
  {
    version: 1,
    id: "camera",
    name: "Camera",
    body: { path: "M17 34H20V31C20 29 21 28 23 28H27C29 28 30 29 30 31V34H36L40 23C41 21 42 20 44 20H56C58 20 59 21 60 23L64 34H83C87.5 34 91 37.5 91 42V72C91 76.5 87.5 80 83 80H17C12.5 80 9 76.5 9 72V42C9 37.5 12.5 34 17 34Z" },
    eyes: { x: 50, y: 54, spacing: 17, scale: 1.1 },
  },
  {
    version: 1,
    id: "cat",
    name: "Cat",
    body: { path: "M50 23C68 23 82 30 82 45C82 58 68 65 50 65C32 65 18 58 18 45C18 30 32 23 50 23ZM24 42C21 32 20 22 22 15C23 11 26 10 29 12C34 16 39 21 44 28L36 42ZM64 42L56 28C61 21 66 16 71 12C74 10 77 11 78 15C80 22 79 32 76 42ZM38 56L62 56C70 56 74 66 74 76C74 83 70 86 63 86L37 86C30 86 26 83 26 76C26 66 30 56 38 56ZM70 72C77 74 81 70 80 64C79 60 81 57 84 58C87 59 88.5 63 88 68C87 77 80 83 70 81Z" },
    eyes: { x: 50, y: 43, spacing: 17, scale: 1.1 },
  },
  {
    version: 1,
    id: "cloud",
    name: "Cloud",
    body: { path: "M24 76C14 76 9 69 9 61C9 52 15 46 23 45.5C25 33 36 24 49 24C61 24 70 31 73 41C83 41 91 49 91 59C91 69 83 76 74 76Z" },
    eyes: { x: 50, y: 54, spacing: 17, scale: 1.15 },
  },
  {
    version: 1,
    id: "egg",
    name: "Egg",
    body: { path: "M50 10C66 10 82 34 82 58C82 76 68 88 50 88C32 88 18 76 18 58C18 34 34 10 50 10Z" },
    eyes: { x: 50, y: 54, spacing: 17, scale: 1.2 },
  },
  {
    version: 1,
    id: "ghost",
    name: "Ghost",
    body: { path: "M24 50C24 28 35 12 50 12C65 12 76 28 76 50L77 80C77 85 73 88 68 88C63 88 61 84 59 81C57 84 54 88 50 88C46 88 43 84 41 81C39 84 37 88 32 88C27 88 23 85 23 80Z" },
    eyes: { x: 50, y: 42, spacing: 16, scale: 1.15 },
  },
  {
    version: 1,
    id: "magnifier",
    name: "Magnifier",
    body: { path: "M41 12A29 29 0 0 1 64.44 58.08L68.50 62.13A8 8 0 0 1 75.65 64.33L87.67 76.36A8 8 0 0 1 76.36 87.67L64.33 75.65A8 8 0 0 1 62.13 68.50L58.08 64.44A29 29 0 1 1 41 12Z" },
    eyes: { x: 41, y: 40, spacing: 17, scale: 1.15 },
  },
  {
    version: 1,
    id: "paint-brush",
    name: "Paint Brush",
    body: { path: "M77.2 8.5C80.3 8.7 82.3 10.2 83.4 13.1C84 14.5 83.3 16.2 82.3 17.6L65.9 40.8L56.2 33.7L73.2 11C74.2 9.6 75.6 8.5 77.2 8.5ZM55.4 26.8L72.8 39.4C74.2 40.4 74.5 42.2 73.5 43.6L66.6 53C65.6 54.4 63.8 54.7 62.4 53.7L45.1 41C43.7 40 43.4 38.2 44.4 36.8L51.2 27.4C52.2 26 54 25.8 55.4 26.8ZM48.4 38.7L63.7 49.8C67.9 57.1 66.8 65.9 61.8 72.9C54.7 82.6 41.2 86.6 25.2 85.1C22.2 85 20 82.9 21 79.9C24.6 71.4 21.1 57.1 28.2 47.4C33.3 40.4 40.8 37.4 48.4 38.7Z" },
    eyes: { x: 44, y: 59, spacing: 16, scale: 1.05 },
  },
  {
    version: 1,
    id: "palette",
    name: "Palette",
    body: { path: "M46 18C70 16 90 28 90 48C90 68 74 84 52 84C42 84 36 80 34 74C32 68 36 64 32 60C28 56 22 62 16 58C10 54 10 46 12 40C16 26 30 19 46 18ZM21 44A5 5 0 1 0 31 44A5 5 0 1 0 21 44Z" },
    eyes: { x: 58, y: 46, spacing: 17, scale: 1.15 },
  },
  {
    version: 1,
    id: "rocket",
    name: "Rocket",
    body: { path: "M46 10C48 8.5 52 8.5 54 10C64 17 71 29 71 44V72H29V44C29 29 36 17 46 10ZM29 56H71C80 61 86 70 86 80C86 84 83 86 79 85L72 83H28L21 85C17 86 14 84 14 80C14 70 20 61 29 56ZM42 80H58C59 86 55 90 50 92C45 90 41 86 42 80Z" },
    eyes: { x: 50, y: 46, spacing: 15, scale: 1.05 },
  },
  {
    version: 1,
    id: "shield",
    name: "Shield",
    body: { path: "M50 14C60 18 72 18 82 16Q86 16 86 20L86 46C86 64 72 78 54 86.5Q50 88.5 46 86.5C28 78 14 64 14 46L14 20Q14 16 18 16C28 18 40 18 50 14Z" },
    eyes: { x: 50, y: 42, spacing: 17, scale: 1.15 },
  },
  {
    version: 1,
    id: "star",
    name: "Star",
    body: { path: "M53.7 17.95L62 31.2Q64.1 34.6 68 35.6L83.1 39.3Q89.9 41 85.4 46.4L75.4 58.3Q72.8 61.4 73.1 65.4L74.2 81Q74.7 88 68.2 85.4L53.7 79.5Q50 78 46.3 79.5L31.8 85.4Q25.3 88 25.8 81L26.9 65.4Q27.2 61.4 24.6 58.3L14.6 46.4Q10.1 41 16.9 39.3L32 35.6Q35.9 34.6 38 31.2L46.3 17.95Q50 12 53.7 17.95Z" },
    eyes: { x: 50, y: 52, spacing: 16, scale: 1.1 },
  },
  {
    version: 1,
    id: "witch-hat",
    name: "Witch Hat",
    body: { path: "M50 72C72 72 92 75 92 80C92 85 72 87 50 87C28 87 8 85 8 80C8 75 28 72 50 72ZM37 30L63 30Q68 30 68.8 35L77.5 76Q78 80 74 80L26 80Q22 80 22.5 76L31.2 35Q32 30 37 30ZM30.56 38C33 26.5 40 18 52 14C62 10.5 72 9 81 11A3.2 3.2 0 0 1 81 17.4C74 18 69.5 24.5 68.1 31.5L69.44 38Z" },
    eyes: { x: 50, y: 54, spacing: 15, scale: 1.05 },
  },
];

const SHIELD = GALLERY.find((one) => one.id === "shield") as AvatarDefinition;
const STAR = GALLERY.find((one) => one.id === "star") as AvatarDefinition;

export const OBJECT_BODIES = Object.fromEntries(
  [...examples, ...GALLERY].filter((one) => one !== SHIELD && one !== STAR).map((definition) => [`obj-${definition.id}`, definition]),
) as Record<ObjectBodyId, AvatarDefinition>;

const shape = (id: string, name: string, path: string, eyes: AvatarDefinition["eyes"]): AvatarDefinition => ({ version: 1, id, name, body: { path }, eyes });

/** Our shapes, drawn for the same engine; Shield and Star are Open Bot Avatar's own. The cursor keeps its own renderer. */
export const SHAPE_BODIES: Record<Exclude<MascotBodyId, "cursor">, AvatarDefinition> = {
  blob: shape("blob", "Blob", "M48 10C64 8 78 16 85 30C92 44 90 62 80 75C70 88 52 93 36 87C20 81 9 66 10 49C11 30 30 12 48 10Z", { x: 50, y: 48, spacing: 18, scale: 1.15 }),
  circle: shape("circle", "Circle", "M50 10A40 40 0 1 1 50 90A40 40 0 1 1 50 10Z", { x: 50, y: 48, spacing: 18, scale: 1.15 }),
  squircle: shape("squircle", "Squircle", "M50 12C78 12 88 22 88 50C88 78 78 88 50 88C22 88 12 78 12 50C12 22 22 12 50 12Z", { x: 50, y: 48, spacing: 18, scale: 1.15 }),
  capsule: shape("capsule", "Capsule", "M50 8C66 8 78 20 78 36V64C78 80 66 92 50 92C34 92 22 80 22 64V36C22 20 34 8 50 8Z", { x: 50, y: 46, spacing: 16, scale: 1.1 }),
  drop: shape("drop", "Drop", "M46.5 12Q50 7 53.5 12C64 27 80 45 80 62C80 79 66 91 50 91C34 91 20 79 20 62C20 45 36 27 46.5 12Z", { x: 50, y: 60, spacing: 16, scale: 1.1 }),
  shield: { ...SHIELD, id: "shield" },
  hexagon: shape("hexagon", "Hexagon", "M40.47 13.5Q50 8 59.53 13.5L76.85 23.5Q86.37 29 86.37 40L86.37 60Q86.37 71 76.85 76.5L59.53 86.5Q50 92 40.47 86.5L23.15 76.5Q13.63 71 13.63 60L13.63 40Q13.63 29 23.15 23.5Z", { x: 50, y: 47, spacing: 18, scale: 1.15 }),
  diamond: shape("diamond", "Diamond", "M40.1 16.9Q50 7 59.9 16.9L83.1 40.1Q93 50 83.1 59.9L59.9 83.1Q50 93 40.1 83.1L16.9 59.9Q7 50 16.9 40.1Z", { x: 50, y: 47, spacing: 16, scale: 1.1 }),
  star: { ...STAR, id: "star" },
};

/** The engine definition a body is drawn from, or undefined for the cursor and the festival bodies. */
export function engineBody(id: unknown): AvatarDefinition | undefined {
  if (typeof id !== "string") return undefined;
  for (const table of [OBJECT_BODIES, SHAPE_BODIES] as Record<string, AvatarDefinition>[]) if (Object.hasOwn(table, id)) return table[id];
  return undefined;
}

// A saved app's launcher icon, drawn as its card draws its mark: the app's first letter on a plate tinted with the colour
// of the bot that made it, so the launcher looks like the card.
import type { MausColor } from "../../shared/wire";
import { appInitial } from "@/lib/published-apps";

export const APP_ICON_SIDE = 256;
const PLATE_TINT = 0.16;

function rgb(css: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (hex) return [0, 2, 4].map((at) => parseInt(hex[1]!.slice(at, at + 2), 16)) as [number, number, number];
  const fn = /^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(css.trim());
  return fn ? [Number(fn[1]), Number(fn[2]), Number(fn[3])] : null;
}

/** The bot's colour as the light skin draws it, or null for an app whose bot is gone. */
function identity(color: MausColor | undefined): [number, number, number] | null {
  if (!color || typeof getComputedStyle === "undefined") return null;
  return rgb(getComputedStyle(document.documentElement).getPropertyValue(`--identity-${color}`));
}

/** A small PNG of the app's mark; undefined where the page can't draw one (the launcher then gets a plain letter tile). */
export async function appIconPng(name: string, color: MausColor | undefined): Promise<Uint8Array | undefined> {
  const canvas = typeof document === "undefined" ? null : document.createElement("canvas");
  const context = canvas?.getContext?.("2d");
  if (!canvas || !context) return undefined;
  canvas.width = canvas.height = APP_ICON_SIDE;
  const ink = identity(color);
  const plate = ink ? ink.map((channel) => Math.round(255 + (channel - 255) * PLATE_TINT)) : [236, 236, 236];
  const side = APP_ICON_SIDE, inset = side * 0.06, radius = side * 0.22;
  context.fillStyle = `rgb(${plate.join(",")})`;
  context.beginPath();
  context.roundRect(inset, inset, side - inset * 2, side - inset * 2, radius);
  context.fill();
  context.fillStyle = ink ? `rgb(${ink.join(",")})` : "rgb(120,120,124)";
  context.font = `600 ${Math.round(side * 0.46)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(appInitial(name), side / 2, side / 2 + side * 0.02);
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
}

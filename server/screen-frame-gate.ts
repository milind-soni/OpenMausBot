import { createHash } from "node:crypto";

import { screenSurfaceForTool, screenTouchingTool } from "../shared/tool-surface.ts";
export { screenSurfaceForTool, screenTouchingTool };

export function screenFrameHash(png: string): string {
  return createHash("sha256").update(png).digest("hex");
}

export function settledFrameIsNews(shownFrameHash: string | undefined, png: string): boolean {
  return shownFrameHash === undefined || screenFrameHash(png) !== shownFrameHash;
}


// Which turns earn a settled screenshot in the transcript.
//
// The screen poller folds a turn's last frame into the chat on turn end.
// Two questions decide whether that frame is worth the reader's attention,
// and both are answered here, pure, so they can be pinned down in tests:
//   1. did the tool that just completed act on (or look at) the screen — a
//      shell command over computer_exec or a status read does not count,
//      however the driver happens to spell the tool's name;
//   2. is the end frame different from the one the transcript already
//      shows — a boxAgent turn starts as screen work by definition, so this
//      is what keeps its shell-only replies from re-picturing the same idle
//      desktop.
import { createHash } from "node:crypto";

// Tool-name classification lives in shared/tool-surface.ts so the renderer
// reads a tool the same way the poller does.
import { screenSurfaceForTool, screenTouchingTool } from "../shared/tool-surface.ts";
export { screenSurfaceForTool, screenTouchingTool };

/** sha256 over the base64 frame — the same fingerprint the model-side
 * observation dedupe uses (server/computer-observation.ts). */
export function screenFrameHash(png: string): string {
  return createHash("sha256").update(png).digest("hex");
}

/** A settled frame is news only when it differs from the frame the reader
 * can already see. With nothing to compare against it fails open, like the
 * observation dedupe does: an unshown screen beats a wrongly hidden one. */
export function settledFrameIsNews(shownFrameHash: string | undefined, png: string): boolean {
  return shownFrameHash === undefined || screenFrameHash(png) !== shownFrameHash;
}


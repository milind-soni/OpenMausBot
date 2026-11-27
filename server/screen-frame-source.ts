import { captureOutsideHumanControl, type PrivateScreenFrame } from "./private-screen-capture.ts";

export type ScreenCapture = () => Promise<{ png: string; format: string }>;
type Surface = "browser" | "computer";

const TURN_FRAME_LIMIT = 64;
const turnFrames = new Map<string, { frame: PrivateScreenFrame; at: number }>();

/** The newest desktop frame a turn captured, keyed by the computer resource it held (`computer:box:<id>`), so viewers
 * outside the turn, such as the Team map, reuse it instead of asking the machine again. */
export function rememberTurnFrame(resource: string | undefined, frame: PrivateScreenFrame, at = Date.now()): void {
  if (!resource) return;
  turnFrames.delete(resource);
  turnFrames.set(resource, { frame, at });
  if (turnFrames.size > TURN_FRAME_LIMIT) turnFrames.delete(turnFrames.keys().next().value!);
}

export function latestTurnFrame(resource: string): { frame: PrivateScreenFrame; at: number } | undefined {
  return turnFrames.get(resource);
}

/** A cached or in-flight desktop frame must never become the browser's settled picture after a surface switch. */
export function createScreenFrameSource(input: {
  captures: { computer?: ScreenCapture; browser?: ScreenCapture };
  control: () => { held: boolean; revision: number };
  onFrame: (frame: PrivateScreenFrame, surface: Surface) => void;
  minGapMs: number;
}) {
  let current: Promise<void> | null = null;
  let lastAt = 0;
  let attemptedSurface: Surface | undefined;
  let last: PrivateScreenFrame | null = null;
  let lastSurface: Surface | undefined;
  const selectedSurface = (): Surface => input.captures[source.surface]
    ? source.surface
    : input.captures.computer ? "computer" : "browser";
  const source = {
    surface: (input.captures.computer ? "computer" : "browser") as Surface,
    get last(): PrivateScreenFrame | null {
      return lastSurface === selectedSurface() ? last : null;
    },
    async capture(fresh = false): Promise<void> {
      while (current) await current;
      if (input.control().held) return;
      const surface = selectedSurface();
      if (!fresh && attemptedSurface === surface && Date.now() - lastAt < input.minGapMs) return;
      attemptedSurface = surface;
      current = (async () => {
        try {
          const capture = input.captures[surface];
          if (!capture) return;
          const frame = await captureOutsideHumanControl(input.control, capture);
          if (!frame || surface !== selectedSurface()) return;
          last = frame;
          lastSurface = surface;
          input.onFrame(frame, surface);
        } catch {
        } finally {
          lastAt = Date.now();
        }
      })();
      try {
        await current;
      } finally {
        current = null;
      }
    },
  };
  return source;
}

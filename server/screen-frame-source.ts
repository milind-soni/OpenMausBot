import { captureOutsideHumanControl, type PrivateScreenFrame } from "./private-screen-capture.ts";

export type ScreenCapture = () => Promise<{ png: string; format: string }>;
type Surface = "browser" | "computer";

/** One serialized preview source. A cached or in-flight desktop frame must
 * never become the browser's settled picture after the bot switches surfaces. */
export function createScreenFrameSource(input: {
  captures: { computer?: ScreenCapture; browser?: ScreenCapture };
  control: () => { held: boolean; revision: number };
  onFrame: (frame: PrivateScreenFrame) => void;
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
      // Wait for the previous source before selecting the next one. A final
      // capture bypasses the preview throttle, even if a poke just finished.
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
          input.onFrame(frame);
        } catch {
          // A sleeping or mid-command surface is retried by the next tick.
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

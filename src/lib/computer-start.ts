import { useEffect } from "react";

import { t } from "@/lib/i18n";
import { listenLiveFrames } from "@/lib/live-events";
import type { ServerFrame } from "../../shared/wire";

export type ComputerStart = Pick<Extract<ServerFrame, { kind: "computer" }>, "state" | "place">;

export function computerStartLine(start: ComputerStart | undefined, name: string): string | null {
  if (!start) return null;
  if (start.place !== "cloud") return t("chat.provisioning");
  return t(start.state === "waking" ? "chat.computerWaking" : "chat.computerStarting", { name });
}

/** The computer's first screen ends its start line: while one is awaited, the stream carries screen frames. */
export function useScreensWhile(waiting: boolean): void {
  useEffect(() => (waiting ? listenLiveFrames({ screens: true, onFrame: () => {} }) : undefined), [waiting]);
}

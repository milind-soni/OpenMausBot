// The one line a chat shows while a bot's computer starts for its turn: the
// server's `computer` frame (shared/wire.ts) says what is starting, and the
// line goes with the computer's first screen frame or the end of the turn.
import { t } from "@/lib/i18n";
import type { ServerFrame } from "../../shared/wire";

/** A computer being set up or woken for a bot's turn. */
export type ComputerStart = Pick<Extract<ServerFrame, { kind: "computer" }>, "state" | "place">;

/** What the chat says while it starts, or null when nothing is starting. */
export function computerStartLine(start: ComputerStart | undefined, name: string): string | null {
  if (!start) return null;
  if (start.place !== "cloud") return t("chat.provisioning");
  return t(start.state === "waking" ? "chat.computerWaking" : "chat.computerStarting", { name });
}

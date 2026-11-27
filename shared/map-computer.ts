/** How the Team map names a computer's state. */
export type MapComputerState = "starting" | "working" | "idle" | "asleep" | "off" | "problem";

/** One computer drawn on the Team map. `id` is its owner: the bot's id, or the team computer's owner key. */
export interface MapComputer {
  id: string;
  kind: "bot" | "team";
  name: string;
  /** The team a shared computer belongs to; absent for a bot's own computer. */
  section?: string;
  botIds: string[];
  state: MapComputerState;
  /** `data` (base64) comes only when the caller does not already hold this version; the event stream carries turn frames. */
  frame?: { version: string; at: number; mime: string; source: "turn" | "map"; data?: string };
}

/** GET /api/computers/frames. `now` is the server's clock, for the age of each frame. */
export interface MapComputersPayload {
  configured: boolean;
  available: boolean;
  now: number;
  computers: MapComputer[];
}

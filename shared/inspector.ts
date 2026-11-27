/** The inspector's wire data: what a thread's turn actually looked like. */
import type { RuntimeEvent } from "./runtime-events.ts";

/** One line of native/<threadId>.ndjson. */
export interface NativeRecord {
  at: string;
  dir: "in" | "out";
  source: string;
  msg: unknown;
}

export type InspectorEntry =
  | { kind: "runtime"; at: string; data: RuntimeEvent }
  | { kind: "native"; at: string; data: NativeRecord };

export interface InspectorPage {
  entries: InspectorEntry[];
  /** line counts before the cap, so the UI can say "showing 200 of 1,687" */
  total: { runtime: number; native: number };
}


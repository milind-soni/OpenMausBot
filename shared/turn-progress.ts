// The live status line's vocabulary, shared by the drivers that report it, the bus that coalesces it and the chat that
// shows it. A turn.progress event is live only: it is never written to the event log or the message log.

/** What a tool call is doing, in the status line's words: writing or changing a file, running a command, searching the
 * web, reading a file or a page, searching files, or any other tool. */
export type TurnProgressActivity = "write" | "edit" | "command" | "web" | "read" | "fetch" | "search" | "tool";

/** What one tool call works on, in the words the status line, its chip and the sidebar use: a command's program and
 * main target ("scrape.py", "pnpm test"), a web search's query, a page's site, a file's name. Server-made from redacted
 * text and redacted again: never an environment variable's value or a credential. */
export interface LiveStep {
  activity: TurnProgressActivity;
  /** At most 60 characters. */
  target: string;
  /** The whole command, query or page address the target was read from, environment values left out; at most 200
   * characters, and absent when it says no more than the target. */
  detail?: string;
}

/** How a call that has run a while is doing: when its output last arrived (epoch ms), or, while it has sent none, what
 * its processes show: holding a network connection, using the CPU, or neither. */
export type StepQuiet = { kind: "output"; at: number } | { kind: "network" | "busy" | "idle" };

export interface TurnProgressFields {
  type: "turn.progress";
  activity: TurnProgressActivity;
  /** The engine's own tool name, for a tool the activity does not name. */
  tool?: string;
  /** The bare file name the call works on, once the engine has said it. */
  file?: string;
  /** Bytes of the call's input generated so far: for a write, about the size of the file. */
  bytes?: number;
  itemId?: string;
  /** The call's LiveStep target, once the server has read one from the call. */
  target?: string;
  /** The call's LiveStep detail, for the phrase's tooltip. */
  detail?: string;
  /** Set once the call has run past the quiet notice. */
  quiet?: StepQuiet;
  /** A running command's last lines of output, redacted, oldest first. */
  tail?: string[];
}

const KB = 1024;
const MB = 1024 * KB;

/** The size the status line shows: whole KB under a megabyte, tenths of a MB above; nothing under 1 KB. */
export function progressSize(bytes: number | undefined): { unit: "kb" | "mb"; count: number } | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < KB) return null;
  if (bytes < MB) return { unit: "kb", count: Math.floor(bytes / KB) };
  return { unit: "mb", count: Math.floor((bytes / MB) * 10) / 10 };
}

/** A path's last part, without control characters and at most 60 characters: never a whole path on the wire. */
export function progressFile(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.replace(/\p{Cc}/gu, "").trim();
  if (!name) return undefined;
  return name.length > 60 ? `${name.slice(0, 57)}…` : name;
}

/** Two reports that read the same on screen share a key, so only a visible change is worth a frame. */
export function progressKey(event: Omit<TurnProgressFields, "type" | "activity"> & { activity: string; turnId?: string }): string {
  const size = progressSize(event.bytes);
  const quiet = event.quiet ? `${event.quiet.kind}${event.quiet.kind === "output" ? `@${event.quiet.at}` : ""}` : "";
  return [event.turnId ?? "", event.itemId ?? "", event.activity, event.tool ?? "", event.file ?? "", size ? `${size.count}${size.unit}` : "",
    event.target ?? "", event.detail ?? "", quiet, (event.tail ?? []).join("\n")].join("|");
}

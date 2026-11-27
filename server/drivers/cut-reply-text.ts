// The text of a reply that spans output-limit continuations: configured credentials stay masked even when one is split
// between requests, and the pieces reach consumers as one answer.
import { maskSecretHalves } from "./secret-halves.ts";

export { maskSecretHalves } from "./secret-halves.ts";

type StreamKind = "assistant_text" | "reasoning_text";

/** The masked deltas of one reply: a suffix that could start a configured credential is held until the next chunk
 * proves what it is, and the hold survives a cut reply's continuation so a secret split at the cut is never shown in halves. */
export class MaskedDeltas {
  private readonly held: Record<StreamKind, string> = { assistant_text: "", reasoning_text: "" };
  private readonly secrets: readonly string[];
  private readonly safe: (text: string) => string;
  private readonly emit: (text: string, kind: StreamKind) => void;
  constructor(
    secrets: readonly string[],
    safe: (text: string) => string,
    emit: (text: string, kind: StreamKind) => void,
  ) {
    this.secrets = secrets;
    this.safe = safe;
    this.emit = emit;
  }
  seed(kind: StreamKind, text: string) { this.held[kind] = text; }
  feed(text: string, kind: StreamKind, flush = false) {
    const masked = maskSecretHalves(this.held[kind] + text, this.secrets, this.safe, flush);
    this.held[kind] = masked.held;
    if (masked.visible) this.emit(masked.visible, kind);
  }
}

/** The answer a continuation chain builds: emitted once when the chain ends, or when the turn fails, so a consumer that
 * reads the last completed item gets the whole reply instead of its last fragment. */
export class ContinuedReply {
  private text = "";
  private readonly emit: (text: string) => void;
  constructor(emit: (text: string) => void) { this.emit = emit; }
  add(part: string) { this.text += part; }
  end() {
    if (!this.text) return;
    this.emit(this.text);
    this.text = "";
  }
}

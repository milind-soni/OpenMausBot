// The long random pieces of a held value that spans lines or has structure, such as each line of a private key's
// body or the key id in a JSON key file, are masked wherever they appear, so a stream needs no tail as long as the
// whole value: only up to the end of its first piece. A stream also stops for good once any piece shows up in it: the
// rest of a value only begun would otherwise show its skeleton (field names, the lines around the pieces), which the
// saved message hides when the value is whole.
//
// A piece is a run of base64 characters (hex and digits included) at least MIN_PIECE long, with both letters and digits
// and at least MIN_BITS_PER_CHAR bits of entropy per character: key material and ids, never field names (they hold
// "_"), words, "-----END", "true" or a common URL path. Text is matched against the pieces run by run: a run of MIN_MATCH or more such
// characters is masked when it lies inside the value's pieces joined up (so a key's body re-wrapped at another width,
// or one line of it, is masked too). A run of printable ASCII is never cut by a stream, so a run is whole whenever
// any of it is sent.
import { HELD_SECRET_MASK } from "../shared/redact.ts";

const PIECE_RUN = /[A-Za-z0-9+/=]+/g;
const MATCH_RUN = /[A-Za-z0-9+/=]{16,}/g;
/** 24 base64 characters carry up to 144 bits: masking such a run wherever it appears hides nothing else. */
const MIN_PIECE = 24;
/** A shorter run is matched only inside the pieces joined up: 16 characters, up to 96 bits. */
const MIN_MATCH = 16;
/** Random base64 runs carry 5–6 bits a character, random hex 3.5–4 as measured on 40 characters; a run of one or two
 * repeated characters far less. */
const MIN_BITS_PER_CHAR = 3;
const PRINTABLE_ASCII = /^[\x21-\x7e]*$/;

export interface HeldShape {
  /** The value's pieces, joined where only whitespace or an escaped line break lies between them. */
  bodies: string[];
  /** Every MIN_PIECE-long slice of the bodies. */
  windows: Set<string>;
  /** What a stream holds back for this value: in every form it could cut partway, up to the end of the first piece,
   * or the whole form when there is none; 0 when it can cut no form partway. */
  tail: number;
}

function bitsPerChar(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) bits -= (count / text.length) * Math.log2(count / text.length);
  return bits;
}

/** The shape of a held value with its forms (vault-store.ts secretForms). */
export function heldShape(value: string, forms: readonly string[]): HeldShape {
  const unescaped = value.replace(/\\[nrt]/g, "\n");
  // Runs of base64 characters that only whitespace (or an escaped line break) separates are one body, such as the
  // lines of a key's body, short last line included; a body counts only if one of its runs is a piece.
  const groups: Array<{ runs: string[]; end: number }> = [];
  for (const run of unescaped.matchAll(PIECE_RUN)) {
    const last = groups.at(-1);
    if (last && !unescaped.slice(last.end, run.index).trim()) last.runs.push(run[0]);
    else groups.push({ runs: [run[0]], end: 0 });
    groups.at(-1)!.end = run.index + run[0].length;
  }
  const isPiece = (run: string) => run.length >= MIN_PIECE && /\d/.test(run) && /[A-Za-z]/.test(run) && bitsPerChar(run) >= MIN_BITS_PER_CHAR;
  const pieces = groups.flatMap((group) => group.runs.filter(isPiece));
  const bodies = groups.filter((group) => group.runs.some(isPiece)).map((group) => group.runs.join(""));
  const windows = new Set<string>();
  for (const body of bodies) for (let at = 0; at + MIN_PIECE <= body.length; at++) windows.add(body.slice(at, at + MIN_PIECE));
  let tail = 0;
  for (const form of forms) {
    if (PRINTABLE_ASCII.test(form)) continue;
    let first = Infinity;
    for (const piece of pieces) {
      const at = form.indexOf(piece);
      if (at >= 0) first = Math.min(first, at + piece.length);
    }
    tail = Math.max(tail, Number.isFinite(first) ? first : form.length);
  }
  return { bodies, windows, tail };
}

/** Whether `run`, after the character `before`, lies in one of the shapes' pieces. */
function inPieces(run: string, before: string | undefined, shapes: readonly HeldShape[]): boolean {
  // An escaped line break ("\n" in JSON) leaves its letter at the run's start.
  const candidates = before === "\\" && /^[nrt]/.test(run) ? [run, run.slice(1)] : [run];
  for (const shape of shapes) {
    if (!shape.bodies.length) continue;
    for (const candidate of candidates) {
      if (candidate.length < MIN_MATCH) continue;
      if (candidate.length < MIN_PIECE ? shape.bodies.some((body) => body.includes(candidate)) : windowIn(candidate, shape.windows)) return true;
    }
  }
  return false;
}

function windowIn(run: string, windows: ReadonlySet<string>): boolean {
  for (let at = 0; at + MIN_PIECE <= run.length; at++) if (windows.has(run.slice(at, at + MIN_PIECE))) return true;
  return false;
}

/** `text` with every run that lies in a held value's pieces masked. */
export function maskHeldPieces(text: string, shapes: readonly HeldShape[]): string {
  if (!text || !shapes.some((shape) => shape.bodies.length)) return text;
  return text.replace(MATCH_RUN, (run: string, offset: number) => (inPieces(run, text[offset - 1], shapes) ? HELD_SECRET_MASK : run));
}

/** Whether `text` holds a run that lies in a held value's pieces. */
export function heldPiecesIn(text: string, shapes: readonly HeldShape[]): boolean {
  if (!text || !shapes.some((shape) => shape.bodies.length)) return false;
  MATCH_RUN.lastIndex = 0;
  for (let run = MATCH_RUN.exec(text); run; run = MATCH_RUN.exec(text)) {
    if (inPieces(run[0], text[run.index - 1], shapes)) return true;
  }
  return false;
}

/** The longest tail among `shapes`. */
export function heldTail(shapes: readonly HeldShape[]): number {
  let tail = 0;
  for (const shape of shapes) tail = Math.max(tail, shape.tail);
  return tail;
}

/** Shapes for a list of values, rebuilt only when the list changes. */
export class HeldShapes {
  private key: string | null = null;
  private shapes: HeldShape[] = [];

  private readonly formsOf: (value: string) => string[];

  constructor(formsOf: (value: string) => string[]) {
    this.formsOf = formsOf;
  }

  of(values: readonly string[]): HeldShape[] {
    const key = values.join("\u0000");
    if (key !== this.key) {
      this.key = key;
      this.shapes = values.map((value) => heldShape(value, this.formsOf(value))).filter((shape) => shape.tail > 0 || shape.bodies.length);
    }
    return this.shapes;
  }
}

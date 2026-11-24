// A run that handed work to teammate bots, as this bot's own steps. A hand-off is never a step itself (no "ask Kiwi"):
// a save reads each teammate's thread for the work it was sent, in the order it was sent, and brings that teammate's
// real steps in, so the burger runs the same with the teammate gone. What a teammate did by judgement becomes an AI
// step that keeps the exact brief it was given, the steps it read, and its answer last time as an example. Nested
// hand-offs are followed one level more (two in all); past that, or where a teammate's work can't be read (another
// place's bot, a bot since deleted, a bot this person may not see), the part stays one AI step with its brief.
import { redactSecretsInText } from "../redact.ts";
import { WORKFLOW_MAX_STEPS } from "./format.ts";
import { layersOf, sentTo, sinceAsk, stackLayers, type BurgerLayer, type RunMessage } from "./layers.ts";

/** Hand-offs followed: the run's own, and its teammates' own once more. */
export const TEAMMATE_DEPTH = 2;
export const EXAMPLE_MAX = 1_500;
const BRIEF_MAX = 4_000;
const NOTE_MAX = 120;
/** A reply this long was written work, not a "done": the part keeps an AI step that writes it again. */
const WRITTEN_REPLY = 160;
/** Room left for the decide steps a save may add. */
const STEPS_CAP = WORKFLOW_MAX_STEPS - 4;

export interface TeammateSource {
  /** A thread's messages, or null when it isn't here (another place's, or gone). */
  messages(threadId: string): readonly RunMessage[] | null;
  /** The teammate bot, or null once it's gone. */
  bot(botId: string): { name: string } | null;
  /** Whether the person saving may see this bot's work: view rights or more. */
  mayRead(botId: string): boolean;
  /** The teammate's folder for that thread: a path inside it is kept relative to wherever the burger runs. */
  folder?(botId: string, threadId: string): string | undefined;
}

interface Walk {
  source: TeammateSource;
  depth: number;
  visited: ReadonlySet<string>;
  live: ReadonlySet<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const clean = (text: string | undefined, max: number) => (text?.trim() ? clip(redactSecretsInText(text.trim()), max) : undefined);

/** A brief's first sentence, cut at a word within `max` characters. */
function firstSentence(brief: string, max: number): string {
  const first = brief.trim().split(/\r?\n/, 1)[0]!.split(/(?<=[.!?])\s/, 1)[0]!.replace(/[.!?]+$/, "").trim();
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 1);
  const word = cut.lastIndexOf(" ");
  return `${(word > max / 2 ? cut.slice(0, word) : cut).replace(/[\s,;:]+$/, "")}…`;
}

/** A brief as a step's line: its first sentence, cut at a word within 60 characters. */
export function briefLine(brief: string): string {
  const line = firstSentence(brief, 60);
  return line ? line[0]!.toUpperCase() + line.slice(1) : "";
}

function parse(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try { const value: unknown = JSON.parse(text); return isRecord(value) ? value : undefined; } catch { return undefined; }
}

/** The result row for the hand-off at `index`: the first later one from that thread nobody claimed yet. */
function resultOf(run: readonly RunMessage[], index: number, threadId: string, claimed: Set<number>): RunMessage | undefined {
  for (let i = index + 1; i < run.length; i += 1) {
    const message = run[i]!;
    if (claimed.has(i) || message.roomRequest?.phase !== "result") continue;
    const from = message.threadRef?.threadId ?? message.comm?.threadId;
    if (from && from !== threadId) continue;
    claimed.add(i);
    return message;
  }
  return undefined;
}

/** What the sender wrote when it handed this work on: its coordinate_bots call's message, kept in its own thread. */
function sentWords(run: readonly RunMessage[], index: number, to: { botId: string }, name: string | undefined): string | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    const message = run[i]!;
    if (message.kind !== "activity" || !/(?:^|__)coordinate_bots$/.test(message.tool?.name ?? "")) continue;
    const input = parse(message.tool?.input);
    const ids = Array.isArray(input?.bot_ids) ? input.bot_ids.filter((id): id is string => typeof id === "string") : [];
    const names = (id: string) => id === to.botId || (id.length >= 8 && to.botId.startsWith(id)) || (name !== undefined && id.toLowerCase() === name.toLowerCase());
    if (typeof input?.message === "string" && (!ids.length || ids.some(names))) return input.message;
  }
  return undefined;
}

/** The teammate's part of its thread: from the request row that started this hand-off to the next one. */
function windowOf(child: readonly RunMessage[], requestId: string | undefined, sent: RunMessage, result: RunMessage | undefined, to: { botId: string; room?: string }) {
  const isRequest = (message: RunMessage) => message.roomRequest?.phase === "request";
  let start = requestId ? child.findIndex((message) => isRequest(message) && message.roomRequest!.id === requestId) : -1;
  if (start < 0) {
    // No result yet, or a request shared by several teammates: the newest request from the hand-off on.
    for (let i = child.length - 1; i >= 0; i -= 1) {
      if (isRequest(child[i]!) && (sent.at === undefined || child[i]!.at === undefined || child[i]!.at! >= sent.at - 5_000)) { start = i; break; }
    }
  }
  if (start < 0) return null;
  const next = child.findIndex((message, i) => i > start && isRequest(message));
  const rows = child.slice(start + 1, next < 0 ? child.length : next).filter((message) =>
    // In a room, only this teammate's own rows; and nothing the person did in that thread after the work came back.
    (!to.room || !message.from || message.from.botId === to.botId) && (result?.at === undefined || message.at === undefined || message.at <= result.at + 1_000));
  return { request: child[start]!, rows };
}

/** The words the request row gave the teammate, without the @names it was addressed with. */
function requestWords(request: RunMessage, name: string | undefined): string | undefined {
  let text = request.text?.trim() ?? "";
  if (name && text.startsWith(`@${name}`)) text = text.slice(name.length + 1).trimStart();
  text = text.replace(/^(?:@\S+\s+)+/, "");
  return text || undefined;
}

/** A teammate's step made this bot's: no folder of the teammate's own, and a path in it kept relative. */
function rebase(layer: BurgerLayer, folder: string | undefined): BurgerLayer {
  if (layer.kind === "shell" && layer.args && "cwd" in layer.args) {
    const { cwd: _cwd, ...args } = layer.args;
    return { ...layer, args };
  }
  if (layer.kind !== "file" || typeof layer.args?.path !== "string") return layer;
  const path = layer.args.path;
  if (!/^(?:\/|[A-Za-z]:[\\/]|~)/.test(path)) return layer;
  const root = folder?.replace(/[\\/]+$/, "");
  if (root && (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))) return { ...layer, args: { ...layer.args, path: path.slice(root.length + 1) } };
  // A file outside the teammate's folder: a replay writes only in its own folder, so the AI does this one again.
  return { ...layer, kind: "ai", replay: "ai", words: `write ${layer.words}`, args: { path } };
}

/** The one AI step a teammate's part becomes when its steps can't be brought in, or for what it wrote by judgement. */
function judgement(sent: RunMessage, part: { brief?: string; example?: string; name?: string; uses?: string[] }, suffix: string): BurgerLayer {
  const brief = part.brief ?? "";
  return {
    id: `${sent.id}${suffix}`, messageId: sent.id, kind: "ai", tool: "teammate", words: briefLine(brief) || "Finish the work", status: "done", read: false,
    where: "bot", replay: "ai", ...(brief ? { brief } : {}), ...(part.example ? { example: part.example } : {}),
    ...(part.uses?.length ? { uses: part.uses } : {}), ...(part.name ? { from: { name: part.name } } : {}),
  };
}

interface Part { layers: BurgerLayer[]; whole: BurgerLayer }

function handoff(run: readonly RunMessage[], index: number, claimed: Set<number>, walk: Walk, parts: Map<string, Part>): BurgerLayer[] {
  const sent = run[index]!;
  const to = sentTo(sent)!;
  const result = resultOf(run, index, to.threadId, claimed);
  const bot = walk.source.bot(to.botId);
  const name = bot?.name ?? result?.from?.name ?? to.name;
  const failed = result?.tool?.ok === false;
  const example = failed ? undefined : clean(result?.tool?.output, EXAMPLE_MAX);
  const said = sentWords(run, index, to, name) ?? sent.tool?.output;
  const readable = bot && walk.source.mayRead(to.botId) && walk.depth < TEAMMATE_DEPTH && !walk.visited.has(to.threadId);
  const child = readable ? walk.source.messages(to.threadId) : null;
  const part = child?.length ? windowOf(child, result?.roomRequest?.id, sent, result, to) : null;
  const brief = clean(part ? requestWords(part.request, name) ?? said : said, BRIEF_MAX);
  const whole = judgement(sent, { brief, example, name }, "");
  if (!part) {
    parts.set(sent.id, { layers: [whole], whole });
    return [whole];
  }
  const folder = walk.source.folder?.(to.botId, to.threadId);
  // A teammate's call that never finished (its turn was stopped or cut) is no step to repeat.
  const unfinished = new Set(part.rows.filter((message) => message.kind === "activity" && message.tool && message.tool.ok === undefined).map((message) => message.id));
  const inner = walkRun(part.rows, { ...walk, depth: walk.depth + 1, visited: new Set([...walk.visited, to.threadId]), live: unfinished }, new Map())
    .map((layer) => (layer.status === "running" ? { ...layer, status: "failed" as const } : layer));
  const prefix = (id: string) => `${sent.id}/${id}`;
  const own = inner.map((layer) => {
    const moved = rebase(layer, folder);
    const note = moved.kind === "browser" && !moved.note && brief ? firstSentence(brief, NOTE_MAX) : moved.note;
    const from = moved.from ?? (name ? { name } : undefined);
    return { ...moved, id: prefix(moved.id), ...(moved.uses ? { uses: moved.uses.map(prefix) } : {}), ...(from ? { from } : {}), ...(note ? { note } : {}) };
  });
  const changed = own.some((layer) => !layer.read && layer.status === "done");
  // What the teammate wrote, or what it never finished, is done again by judgement with its brief.
  const wrote = failed || !own.length || !changed || (example?.length ?? 0) >= WRITTEN_REPLY;
  const layers = wrote ? [...own, judgement(sent, { brief, example, name, uses: own.filter((layer) => layer.read).map((layer) => layer.id) }, "/judgement")] : own;
  parts.set(sent.id, { layers, whole });
  return layers;
}

/** The layers of `run`, with each hand-off's teammate steps where the hand-off was. */
function walkRun(run: readonly RunMessage[], walk: Walk, parts: Map<string, Part>): BurgerLayer[] {
  const claimed = new Set<number>();
  const out: BurgerLayer[] = [];
  run.forEach((message, index) => {
    if (sentTo(message)) { out.push(...handoff(run, index, claimed, walk, parts)); return; }
    // A page opened right after the bot said what it was after keeps that as its note.
    const before = run[index - 1];
    const said = before && before.role !== "user" && before.kind === "text" ? before.text?.trim() : undefined;
    for (const layer of layersOf(message, walk.live)) out.push(layer.kind === "browser" && said ? { ...layer, note: clean(firstSentence(said, NOTE_MAX), NOTE_MAX) } : layer);
  });
  return stackLayers(out);
}

const stable = (value: unknown): string => JSON.stringify(value, (_key, inner: unknown) =>
  isRecord(inner) ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]])) : inner);

/** The run since the person's last ask with every teammate's work brought in as this bot's own steps. A teammate step
 * the same as one already taken (same tool, same args: a later round redoing it) is left out once. */
export function teamLayers(messages: readonly RunMessage[], source: TeammateSource, live: ReadonlySet<string> = new Set()): BurgerLayer[] {
  return flattenRun(sinceAsk(messages), source, live);
}

/** `run` (rows already cut to one run) with teammates' work brought in. */
export function flattenRun(run: readonly RunMessage[], source: TeammateSource, live: ReadonlySet<string> = new Set()): BurgerLayer[] {
  const parts = new Map<string, Part>();
  const layers = walkRun(run, { source, depth: 0, visited: new Set(), live }, parts);
  const taken = new Map<string, string>();
  const same = new Map<string, string>();
  /** A part sent again with the same brief (a redo) is kept once, with its newest answer as the example. */
  const latest = new Map<string, string | undefined>();
  const partKey = (layer: BurgerLayer) => (layer.from && layer.brief !== undefined ? `${layer.from.name}|${layer.brief}` : null);
  for (const layer of layers) { const key = partKey(layer); if (key) latest.set(key, layer.example ?? latest.get(key)); }
  const out: BurgerLayer[] = [];
  for (const layer of layers) {
    const part = partKey(layer);
    const key = part ? `part|${part}` : layer.args && layer.replay === "exact" ? `${layer.kind}|${layer.tool}|${layer.app ?? ""}|${layer.where}|${stable(layer.args)}` : null;
    const first = key ? taken.get(key) : undefined;
    // A change done again after something else changed (staging a file after it was rewritten) is not a repeat.
    const since = first === undefined ? -1 : out.findIndex((kept) => kept.id === first);
    const repeat = first !== undefined && Boolean(layer.from) && (Boolean(part) || layer.read || !out.slice(since + 1).some((kept) => !kept.read && kept.kind !== "ai"));
    if (repeat) { same.set(layer.id, first!); continue; }
    if (key) taken.set(key, layer.id);
    out.push(layer);
  }
  let kept = out.map((layer) => {
    const part = partKey(layer);
    const example = part ? latest.get(part) : layer.example;
    return { ...layer, ...(example ? { example } : {}), ...(layer.uses ? { uses: [...new Set(layer.uses.map((id) => same.get(id) ?? id))] } : {}) };
  });
  // Too many steps for one burger: the biggest teammate parts are kept as their one brief step, until it fits.
  while (kept.length > STEPS_CAP) {
    const sizes = [...parts].map(([id, part]) => [id, kept.filter((layer) => layer.id.startsWith(`${id}/`)).length, part] as const).filter(([, size]) => size > 1);
    if (!sizes.length) break;
    const [id, , part] = sizes.reduce((a, b) => (b[1] > a[1] ? b : a));
    const at = kept.findIndex((layer) => layer.id.startsWith(`${id}/`));
    kept = [...kept.slice(0, at).filter((layer) => !layer.id.startsWith(`${id}/`)), part.whole, ...kept.slice(at).filter((layer) => !layer.id.startsWith(`${id}/`))];
  }
  return kept;
}

/** The hand-offs in the run since the person's last ask: a run of only hand-offs still has a burger to show. */
export const handoffsIn = (messages: readonly RunMessage[]): RunMessage[] => sinceAsk(messages).filter((message) => sentTo(message) !== null);

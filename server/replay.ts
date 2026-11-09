// A finished job as a replay (shared/replay.ts): one request of the person's in a bot's own conversation, what the bot did
// until the person's next message, and the browser steps it recorded meanwhile. Only the request, each step's words and
// the answer go in: never a tool's output, a file, or the person's other messages. Every text is redacted again here.
import { readFileSync } from "node:fs";

import { REPLAY_MAX_STEPS, REPLAY_TEXT_MAX, chooseScreenshots, renderReplayHtml, type ReplayModel, type ReplayStep } from "../shared/replay.ts";
import { redactSecretsInText, scrubHeldSecrets } from "../shared/redact.ts";
import { EVIDENCE_LIMITS, type StepRecord } from "./browser-evidence.ts";
import type { Message } from "./store.ts";

export interface ReplayDeps {
  /** The conversation's bot; null for a room or a conversation that is gone. */
  bot(threadId: string): { id: string; name: string } | null;
  messages(threadId: string): readonly Message[];
  /** Every browser step recorded in the conversation, oldest first. */
  steps(threadId: string): readonly StepRecord[];
  imageFile(threadId: string, generation: string, file: string): string | null;
}

export interface ReplayJob {
  requestId: string;
  at: number;
  text: string;
}

export interface BuiltReplay {
  requestId: string;
  model: ReplayModel;
  /** Each pictured step's screenshot on disk, by its replay number. */
  images: Map<number, string>;
  /** The same screenshots as the owner's app reads them (routes/browser-evidence.ts), for the preview. */
  imageUrls: Map<number, string>;
}

export class ReplayError extends Error {
  readonly status: number;
  constructor(message: string, status = 404) {
    super(message);
    this.status = status;
  }
}

const clean = (text: unknown, max = REPLAY_TEXT_MAX) =>
  typeof text === "string" ? scrubHeldSecrets(redactSecretsInText(text)).replace(/\s+\n/g, "\n").trim().slice(0, max) : "";

/** Where a page was, as a person reads it: its host and path. The query and fragment can carry codes, so they never go. */
function site(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return clean(`${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`, 300);
  } catch {
    return undefined;
  }
}

const isRequest = (message: Message) => message.role === "user" && message.kind === "text" && Boolean(message.text?.trim());
const isBrowserTool = (name: string | undefined) => Boolean(name && /agent_browser|fill_login/.test(name));

/** The person's requests a bot answered, newest first. */
export function replayJobs(messages: readonly Message[]): ReplayJob[] {
  const jobs: ReplayJob[] = [];
  messages.forEach((message, index) => {
    if (!isRequest(message)) return;
    const next = messages.slice(index + 1);
    const end = next.findIndex(isRequest);
    const answered = (end < 0 ? next : next.slice(0, end)).some((reply) => reply.role === "bot");
    if (answered) jobs.push({ requestId: message.id, at: message.at, text: clean(message.text, 200) });
  });
  return jobs.reverse();
}

export function buildReplay(deps: ReplayDeps, threadId: string, requestId?: string): BuiltReplay {
  const bot = deps.bot(threadId);
  if (!bot) throw new ReplayError("Replays are for a bot's own conversation.");
  const messages = deps.messages(threadId);
  const job = requestId ? replayJobs(messages).find((one) => one.requestId === requestId) : replayJobs(messages)[0];
  if (!job) throw new ReplayError(requestId ? "That request has no finished job to replay." : "This conversation has no finished job to replay yet.");
  const start = messages.findIndex((message) => message.id === job.requestId);
  const after = messages.slice(start + 1);
  const stop = after.findIndex(isRequest);
  const window = stop < 0 ? after : after.slice(0, stop);
  const endedAt = Math.max(job.at, ...window.map((message) => message.at));
  const until = stop < 0 ? Number.POSITIVE_INFINITY : after[stop]!.at;

  const recorded = deps.steps(threadId).filter((step) => step.at >= job.at && step.at < until);
  const raw: Array<Omit<ReplayStep, "n"> & { file?: { generation: string; name: string } }> = [];
  for (const step of recorded) {
    const page = (step.page ?? null) as { url?: unknown; title?: unknown; navigated?: unknown } | null;
    const action = clean(step.action, 300) || clean(step.kind, 100) || "Browser step";
    const repeat = typeof step.sameAsStep === "number";
    const name = !repeat && typeof step.image === "string" ? step.image : null;
    raw.push({
      at: step.at, kind: "browser", action, ok: step.ok !== false,
      ...(site(page?.url) ? { site: site(page?.url) } : {}),
      ...(clean(page?.title, 200) ? { detail: clean(page?.title, 200) } : {}),
      ...(page?.navigated === true ? { navigated: true } : {}),
      ...(name ? { image: { step: step.step, bytes: typeof step.bytes === "number" ? step.bytes : EVIDENCE_LIMITS.imageBytes }, file: { generation: step.generation, name } } : {}),
    });
  }
  // The conversation's own activity rows say the same as recorded browser steps, so only the other tools' rows are added.
  for (const message of window) {
    if (message.kind !== "activity" || !message.tool) continue;
    if (recorded.length && isBrowserTool(message.tool.name)) continue;
    const action = clean(message.tool.label, 300) || clean(message.tool.name, 100);
    if (!action) continue;
    const detail = clean(message.tool.summary, 400);
    raw.push({ at: message.at, kind: "tool", action, ok: message.tool.ok !== false, ...(detail ? { detail } : {}) });
  }
  raw.sort((a, b) => a.at - b.at);

  const images = new Map<number, string>();
  const imageUrls = new Map<number, string>();
  const steps: ReplayStep[] = raw.slice(0, REPLAY_MAX_STEPS).map(({ file, image, ...step }, index) => {
    const n = index + 1;
    const path = file ? deps.imageFile(threadId, file.generation, file.name) : null;
    if (path) {
      images.set(n, path);
      imageUrls.set(n, `/api/threads/${threadId}/evidence/${file!.generation}/${file!.name}`);
    }
    return { ...step, n, ...(path && image ? { image } : {}) };
  });

  const answer = [...window].reverse().find((message) => message.role === "bot" && message.kind === "text" && message.text?.trim());
  const request = clean(messages[start]!.text);
  return {
    requestId: job.requestId,
    images,
    imageUrls,
    model: {
      title: clean(request.split("\n")[0], 90) || `${bot.name}'s work`,
      bot: clean(bot.name, 100), request, answer: clean(answer?.text), startedAt: job.at, endedAt, steps,
    },
  };
}

/** The screenshots that go: those that fit, less the ones the person took out. */
export function replayPictures(built: BuiltReplay, leaveOut: readonly number[] = []): Set<number> {
  const removed = new Set(leaveOut);
  return new Set([...chooseScreenshots(built.model.steps.filter((step) => !removed.has(step.n)))].filter((n) => built.images.has(n)));
}

const imageName = (n: number) => `img/step-${n}.jpg`;

/** The published page's files: index.html and one picture per kept step. */
export function replayPageFiles(built: BuiltReplay, title: string, leaveOut: readonly number[] = []): Array<{ path: string; data: Buffer }> {
  const kept = replayPictures(built, leaveOut);
  const files: Array<{ path: string; data: Buffer }> = [];
  for (const n of kept) {
    try { files.push({ path: imageName(n), data: readFileSync(built.images.get(n)!) }); } catch { kept.delete(n); }
  }
  const html = renderReplayHtml({ ...built.model, title: clean(title, 200) || built.model.title }, (step) => (kept.has(step.n) ? imageName(step.n) : null));
  return [{ path: "index.html", data: Buffer.from(html) }, ...files];
}

/** The replay as one file to keep or send, its pictures inside it. */
export function replayDownload(built: BuiltReplay, title: string, leaveOut: readonly number[] = []): string {
  const kept = replayPictures(built, leaveOut);
  const inline = new Map<number, string>();
  for (const n of kept) {
    try { inline.set(n, `data:image/jpeg;base64,${readFileSync(built.images.get(n)!).toString("base64")}`); } catch { /* evicted since */ }
  }
  return renderReplayHtml({ ...built.model, title: clean(title, 200) || built.model.title }, (step) => inline.get(step.n) ?? null);
}

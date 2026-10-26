// The internal calls behind the agents server's decide and extract tools. Runs inside index.ts's /api/internal/ block,
// after the capability bearer is checked; the bot is the capability's, never a body field. A file is read only from the
// bot's own folders, by the same rules as a published page. The answer is the models' typed values, never a vendor body.
import type { ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import type { Decider } from "../decider/index.ts";
import { relayAccepts } from "../decider/relay.ts";
import type { DeciderAnswer, DeciderFailure, DeciderProvider, DeciderQuestion } from "../decider/types.ts";
import { EXTRACT_LIMITS, extractRequestProblem } from "../extractor/contract.ts";
import type { Extractor } from "../extractor/index.ts";
import type { ExtractImage, ExtractInput, FieldSchema } from "../extractor/types.ts";
import type { json as sendJson } from "../harness/http.ts";
import { botFileSource, PageBundleError, type BotFolders } from "../pages/bundle.ts";
import { PASS } from "./table.ts";

export interface HelperToolDeps {
  decider: Pick<Decider, "ask">;
  extractor: Pick<Extractor, "extract">;
}

export interface HelperToolContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  botId: string;
  readBody: () => Promise<unknown>;
  folders: BotFolders;
}

const DECIDE = "/api/internal/helpers/decide";
const EXTRACT = "/api/internal/helpers/extract";
export const HELPER_TOOL_TIMEOUT_MS = 20_000;
const IMAGE_TYPES: Record<string, ExtractImage["mime"]> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const TEXT_FILE_BYTES = 1024 * 1024;

export const HELPER_MESSAGES = {
  decideOff: "Decisions aren't set up on this computer. Ask the person to add a free Cloudflare Workers AI key (or a Jev key) in Settings → Decision and extraction.",
  extractOff: "Extraction isn't set up on this computer. Ask the person to add a free Cloudflare Workers AI key in Settings → Decision and extraction.",
  decideShape: "Keep to 8 questions; ids and option keys use letters, digits, _ . or -; a choice has 2 to 20 options, a score 2 to 10 levels; instructions under 1,000 characters and the state under 24 KB.",
} as const;

const FAILURE: Partial<Record<DeciderFailure, string>> = {
  rejected: "The helper model refused its key. Ask the person to check it in Settings → Decision and extraction.",
  rate_limited: "The helper model's allowance is used up for now. Try again later, or do this yourself.",
  overloaded: "The helper model is busy. Try again in a minute.",
  timeout: "The helper model took too long. Try a smaller input.",
  unreachable: "The helper model could not be reached. Try again shortly.",
  misconfigured: "That request is outside what the helper model takes.",
  too_large: "That is too large for the helper model. Send less text or a smaller image; trying the same again will not work.",
};
const BY: Record<DeciderProvider, string> = { jev: "Jev", workersai: "Cloudflare Workers AI", openrouter: "OpenRouter" };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

/** The bot's questions in the decider's own shape; a string naming the first thing wrong, in words a bot can fix. */
export function botQuestions(raw: unknown): Record<string, DeciderQuestion> | string {
  if (!isRecord(raw) || !Object.keys(raw).length) return "questions must be an object of id → question.";
  const out: Record<string, DeciderQuestion> = {};
  for (const [id, question] of Object.entries(raw)) {
    const instructions = isRecord(question) ? text(question.instructions) : null;
    if (!isRecord(question) || !instructions) return `${id}: give type and instructions.`;
    if (question.type === "choice") {
      if (!isRecord(question.options) || !Object.values(question.options).every((meaning) => text(meaning))) return `${id}: a choice needs options, key → what it means.`;
      out[id] = { type: "choice", instructions, options: question.options as Record<string, string> };
    } else if (question.type === "score") {
      if (!Array.isArray(question.levels) || !question.levels.every((level) => text(level))) return `${id}: a score needs levels, lowest first.`;
      out[id] = { type: "score", instructions, levels: question.levels as string[] };
    } else if (question.type === "yesno") {
      out[id] = { type: "yesno", instructions };
    } else {
      return `${id}: type is choice, yesno or score.`;
    }
  }
  return out;
}

const round = (value: number): number => Math.round(value * 100) / 100;

function renderAnswer(question: DeciderQuestion, answer: DeciderAnswer): Record<string, unknown> {
  if (answer.type === "choice") return { choice: answer.choice, p: round(answer.pTop), probabilities: Object.fromEntries(Object.entries(answer.probabilities).map(([key, p]) => [key, round(p ?? 0)])) };
  if (answer.type === "score") return { score: round(answer.score), likely: question.type === "score" ? question.levels[answer.level] : answer.level, probabilities: answer.probabilities.map(round) };
  return { yes: round(answer.p) };
}

async function readInput(body: Record<string, unknown>, folders: BotFolders): Promise<ExtractInput | string> {
  const file = text(body.file);
  if (!file) return typeof body.text === "string" ? { text: body.text } : {};
  let target: string;
  try {
    target = await botFileSource(file, folders);
  } catch (error) {
    if (!(error instanceof PageBundleError)) throw error;
    return error.status === 403 ? "Only files in your working folder can be read. Save it there first." : `Nothing was found at ${file.slice(0, 200)}.`;
  }
  const info = await stat(target);
  if (!info.isFile()) return "file must be a file, not a folder.";
  const extension = extname(target).toLowerCase();
  if (extension === ".pdf") return "PDFs aren't read directly yet: pass the text, or an image of the page.";
  const mime = IMAGE_TYPES[extension];
  if (mime) {
    if (info.size > EXTRACT_LIMITS.imageBytes) return "The image is over 1 MB. Make it smaller first.";
    return { ...(typeof body.text === "string" ? { text: body.text } : {}), images: [{ mime, data: (await readFile(target)).toString("base64") }] };
  }
  if (info.size > TEXT_FILE_BYTES) return "The file is over 1 MB. Pass the part that matters as text.";
  const content = (await readFile(target)).toString("utf8");
  if (content.includes("\u0000")) return "That file is not text or a PNG, JPEG or WebP image.";
  return { text: content.slice(0, EXTRACT_LIMITS.text) };
}

export function createHelperToolRoutes(deps: HelperToolDeps) {
  return async (ctx: HelperToolContext): Promise<typeof PASS | void> => {
    if (ctx.method !== "POST" || (ctx.path !== DECIDE && ctx.path !== EXTRACT)) return PASS;
    const body = await ctx.readBody();
    if (!isRecord(body)) return void ctx.json(ctx.res, 400, { error: "Send a JSON object." });
    if (ctx.path === DECIDE) {
      const questions = botQuestions(body.questions);
      if (typeof questions === "string") return void ctx.json(ctx.res, 400, { error: questions });
      const state = typeof body.state === "string" ? body.state : "";
      if (!relayAccepts("botDecide", state, questions)) return void ctx.json(ctx.res, 400, { error: HELPER_MESSAGES.decideShape });
      const result = await deps.decider.ask("botDecide", state, questions, { careful: true, timeoutMs: HELPER_TOOL_TIMEOUT_MS });
      if (!result.ok) {
        const off = result.reason === "disabled" || result.reason === "no_key";
        return void ctx.json(ctx.res, off ? 409 : 502, { error: off ? HELPER_MESSAGES.decideOff : FAILURE[result.reason] ?? "The decision model's answer could not be read. Try again." });
      }
      const answers = Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [id, renderAnswer(questions[id]!, answer)]));
      return void ctx.json(ctx.res, 200, {
        text: `${JSON.stringify({ answers, by: BY[result.provider] })}\nProbabilities, not facts: act on a choice only when it is clearly ahead.`,
      });
    }
    const fields = body.fields as FieldSchema;
    const input = await readInput(body, ctx.folders);
    if (typeof input === "string") return void ctx.json(ctx.res, 400, { error: input });
    const problem = extractRequestProblem(fields, input);
    if (problem) return void ctx.json(ctx.res, 400, { error: problem });
    const result = await deps.extractor.extract("botExtract", fields, input, { timeoutMs: HELPER_TOOL_TIMEOUT_MS });
    if (!result.ok) {
      const off = result.reason === "disabled" || result.reason === "no_key";
      return void ctx.json(ctx.res, off ? 409 : 502, { error: off ? HELPER_MESSAGES.extractOff : FAILURE[result.reason] ?? "The extraction model's answer could not be read. Try again." });
    }
    return void ctx.json(ctx.res, 200, {
      text: `${JSON.stringify({ values: result.values, by: BY[result.provider] })}\nnull means the input did not say. Check totals and long sums yourself.`,
    });
  };
}

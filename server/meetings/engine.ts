// How a meeting is run on a cloud computer. The tools, cards and routine only see MeetingEngine, so another engine (a
// hosted meeting-bot service, say) can stand in for this one without changing them.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MeetingEndReason, MeetingPlatform } from "../../shared/meetings.ts";
import { resolveProxy } from "../proxy-paths.ts";

/** One speech-to-text grant for the computer: a short-lived token, never a provider key. */
export type SpeechGrant = { kind: "eleven"; token: string; rotateMs?: number } | { kind: "whisper" };

export interface MeetingStart {
  id: string;
  url: string;
  platform: MeetingPlatform;
  name: string;
  consent: string;
  speech: SpeechGrant;
  maxMs: number;
  lobbyMs: number;
  aloneMs: number;
}

export type MeetingEvent = { seq: number; at: number } & (
  | { type: "phase"; phase: "joining" | "lobby" | "in_meeting" }
  | { type: "consent"; text: string }
  | { type: "participants"; others: number; names: string[] }
  | { type: "segment"; speaker: string | null; text: string; start: number; end: number }
  | { type: "chat"; from: string; text: string }
  | { type: "question"; from: string; text: string }
  | { type: "sent"; id: string; ok: boolean; error?: string }
  | { type: "need_token" }
  | { type: "stt"; status: string; detail?: string }
  | { type: "ended"; reason: MeetingEndReason; detail?: string }
);

/** The computer a meeting runs on: shell commands that answer, and one that is started and left running. */
export interface MeetingComputer {
  run(command: string, timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  start(command: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface MeetingEngine {
  join(computer: MeetingComputer, start: MeetingStart): Promise<void>;
  /** Events after `after`, waiting up to `waitSeconds` for the first; `alive` is false once the bot process is gone. */
  events(computer: MeetingComputer, id: string, after: number, waitSeconds: number): Promise<{ events: MeetingEvent[]; alive: boolean }>;
  chatSend(computer: MeetingComputer, id: string, message: { id: string; text: string }): Promise<void>;
  leave(computer: MeetingComputer, id: string): Promise<void>;
  /** Answers a need_token event. */
  supply(computer: MeetingComputer, id: string, grant: SpeechGrant): Promise<void>;
}

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const ROOT = "$HOME/.mausbot-meet";
const CHUNK = 48_000;

export class MeetingEngineError extends Error {}

function botSource(): { text: string; file: string } {
  const path = resolveProxy("meetings/meetbot");
  const text = readFileSync(path, "utf8");
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return { text, file: `${ROOT}/meetbot-${hash}${path.endsWith(".ts") ? ".ts" : ".mjs"}` };
}

/** Our own bot (server/meetings/meetbot.ts) on the computer; the only engine in v1. */
export function createBotEngine(source: () => { text: string; file: string } = botSource): MeetingEngine {
  const folder = (id: string) => {
    if (!/^[a-z0-9-]{8,64}$/.test(id)) throw new MeetingEngineError("bad meeting id");
    return `${ROOT}/${id}`;
  };
  async function must(computer: MeetingComputer, command: string, what: string, timeoutMs = 60_000): Promise<string> {
    const result = await computer.run(command, timeoutMs);
    if (!result.ok) throw new MeetingEngineError(`${what} failed on the cloud computer: ${(result.stderr || result.stdout).trim().slice(0, 300) || "no answer"}`);
    return result.stdout;
  }
  async function install(computer: MeetingComputer): Promise<string> {
    const bot = source();
    const ready = await computer.run(`test -s ${bot.file} && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 3)'`, 30_000);
    if (ready.ok) return bot.file;
    const node = await computer.run("node -v", 30_000);
    if (!node.ok || Number(/^v(\d+)/.exec(node.stdout.trim())?.[1] ?? 0) < 22) throw new MeetingEngineError("The cloud computer needs Node.js 22 or newer for meeting notes.");
    const encoded = Buffer.from(bot.text).toString("base64");
    await must(computer, `mkdir -p ${ROOT} && : > ${bot.file}.b64`, "Preparing the meeting bot");
    for (let i = 0; i < encoded.length; i += CHUNK) await must(computer, `printf %s ${quote(encoded.slice(i, i + CHUNK))} >> ${bot.file}.b64`, "Copying the meeting bot");
    await must(computer, `base64 -d ${bot.file}.b64 > ${bot.file}.tmp && mv ${bot.file}.tmp ${bot.file} && rm -f ${bot.file}.b64`, "Unpacking the meeting bot");
    return bot.file;
  }
  async function put(computer: MeetingComputer, id: string, command: Record<string, unknown>): Promise<void> {
    const bot = source();
    await must(computer, `node ${bot.file} put ${folder(id)} ${Buffer.from(JSON.stringify(command)).toString("base64")}`, "Reaching the meeting bot", 30_000);
  }
  const speech = (grant: SpeechGrant) => (grant.kind === "eleven" ? { kind: "eleven", token: grant.token, ...(grant.rotateMs ? { rotateMs: grant.rotateMs } : {}) } : { kind: "whisper" });

  return {
    async join(computer, start) {
      const file = await install(computer);
      const dir = folder(start.id);
      const config = {
        url: start.url, platform: start.platform, name: start.name, consent: start.consent, stt: speech(start.speech),
        maxMs: start.maxMs, lobbyMs: start.lobbyMs, aloneMs: start.aloneMs,
      };
      await must(computer, `mkdir -p ${dir} && printf %s ${Buffer.from(JSON.stringify(config)).toString("base64")} | base64 -d > ${dir}/config.json && chmod 600 ${dir}/config.json`, "Setting up the meeting");
      const started = await computer.start(`cd "$HOME" && exec node ${file} run ${dir} >> ${dir}/stdout.log 2>&1`);
      if (!started.ok) throw new MeetingEngineError(started.error);
    },
    async events(computer, id, after, waitSeconds) {
      const bot = source();
      const out = await must(computer, `node ${bot.file} wait ${folder(id)} ${Math.max(0, Math.floor(after))} ${Math.max(0, Math.floor(waitSeconds))}`, "Reading the meeting", (waitSeconds + 45) * 1_000);
      let parsed: { events?: MeetingEvent[]; alive?: boolean };
      try {
        parsed = JSON.parse(out);
      } catch {
        throw new MeetingEngineError("The meeting bot gave an unreadable answer.");
      }
      return { events: Array.isArray(parsed.events) ? parsed.events : [], alive: parsed.alive === true };
    },
    chatSend: (computer, id, message) => put(computer, id, { kind: "chat", id: message.id, text: message.text }),
    leave: (computer, id) => put(computer, id, { kind: "leave" }),
    supply: (computer, id, grant) => (grant.kind === "eleven" ? put(computer, id, { kind: "token", token: grant.token }) : Promise.resolve()),
  };
}

// A bug report goes from this computer to the OpenMausBot team's server: what the person wrote, the diagnostics report
// (credentials are never read and the logs are masked) and, only when they tick it, the open conversation, masked the
// same way. Nothing here runs unless the person presses Send.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CLOUD_ORIGIN, cloudOrigin } from "./cloud-account.mjs";
import { decodeLogTail, redactSecretsInLine } from "./diagnostics.mjs";
import localOriginModule from "./local-origin.cjs";

const { localOnly } = localOriginModule;

export const BUG_REPORT_LOG_TAIL_BYTES = 64 * 1024;
export const BUG_REPORT_TEXT_MAX_BYTES = 256 * 1024;
export const BUG_REPORT_DESCRIPTION_MAX = 10_000;
const RESPONSE_MAX_BYTES = 64 * 1024;
const SEND_TIMEOUT_MS = 20_000;
const CHAT_TIMEOUT_MS = 5_000;
const THREAD_ID = /^[\w-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const BUG_REPORT_ERRORS = Object.freeze({
  empty: "Describe what went wrong first.",
  busy: "A report is already on its way.",
  offline: "Could not reach the OpenMausBot team's server. Check your internet connection and try again.",
  tooLarge: "The report is too large to send.",
  tooLargeWithChat: "The report is too large to send. Leave out the conversation and try again.",
  server: "The OpenMausBot team's server could not take the report right now. Try again in a few minutes.",
  chatUnavailable: "(This conversation could not be read from OpenMausBot on this computer.)",
});

function readEnvironmentId(file) {
  try {
    const id = fs.readFileSync(file, "utf8").trim();
    return UUID.test(id) ? id : null;
  } catch (error) {
    return error?.code === "ENOENT" ? undefined : null;
  }
}

/** The local server's own environment id: random, written once into the data dir and never rotated. Created here the
 * same way the server does when it is missing, so both adopt one id; an unreadable file is never replaced. */
export function installId(dataDir, newId = randomUUID) {
  const file = path.join(dataDir, "environment-id");
  const found = readEnvironmentId(file);
  if (found) return found;
  const id = newId();
  if (found === null) return id;
  const temporary = path.join(dataDir, `.environment-id.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, `${id}\n`, { flag: "wx", mode: 0o600 });
    // A hard link publishes without replacing, so a server that wrote its id first keeps it.
    fs.linkSync(temporary, file);
    return id;
  } catch {
    return readEnvironmentId(file) || id;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** The start of `text` in at most `max` UTF-8 bytes, cut at a line end. */
export function firstBytes(text, max) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= max) return text;
  const head = buffer.subarray(0, max);
  const newline = head.lastIndexOf(0x0a);
  return head.subarray(0, newline < 0 ? 0 : newline + 1).toString("utf8");
}

/** The end of `text` in at most `max` UTF-8 bytes, from a line start: the newest messages of a conversation. */
export function lastBytes(text, max) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= max) return text;
  return decodeLogTail(buffer.subarray(buffer.length - max), true).tail;
}

const redactText = (text) => text.split("\n").map((line) => redactSecretsInLine(line)).join("\n");

function retryWords(seconds) {
  if (!seconds) return "Try again later.";
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes >= 120 ? `Try again in ${Math.ceil(minutes / 60)} hours.` : `Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

const plainSentence = (value) => typeof value === "string" ? value.replace(/\p{Cc}+/gu, " ").trim().slice(0, 200).replace(/[.!\s]+$/, "") : "";

/** One plain sentence for the person; 429 also says when to try again. */
export function bugReportFailure(status, body, { headers, withChat = false } = {}) {
  if (status === 400) {
    const detail = plainSentence(body?.error);
    return { ok: false, error: detail ? `The report was not accepted: ${detail}.` : "The report was not accepted. Update OpenMausBot and try again." };
  }
  if (status === 413) return { ok: false, error: withChat ? BUG_REPORT_ERRORS.tooLargeWithChat : BUG_REPORT_ERRORS.tooLarge };
  if (status === 429) {
    const given = Number(body?.retryAfter ?? headers?.get?.("retry-after"));
    const retryAfter = Number.isFinite(given) && given > 0 ? Math.ceil(given) : undefined;
    return { ok: false, error: `Too many reports were sent from this computer. ${retryWords(retryAfter)}`, ...(retryAfter ? { retryAfter } : {}) };
  }
  return { ok: false, error: BUG_REPORT_ERRORS.server };
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  const chunks = [];
  let size = 0;
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_MAX_BYTES) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  } finally {
    reader?.releaseLock();
  }
}

/**
 * diagnostics(maxLogBytes): the diagnostics report text. localServer(): this computer's server address, read per call.
 * dataDir(): where the install id lives.
 */
export function createBugReporter({
  diagnostics, localServer, dataDir, appVersion, platform,
  origin = CLOUD_ORIGIN, fixture = false, fetch: fetcher = globalThis.fetch,
}) {
  const cloud = cloudOrigin(origin, fixture);
  let sending = false;

  async function chatLog(threadId) {
    try {
      const response = await fetcher(`${localServer()}/api/threads/${threadId}/export?format=markdown`, {
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
      if (!response.ok) return BUG_REPORT_ERRORS.chatUnavailable;
      return lastBytes(redactText(await response.text()), BUG_REPORT_TEXT_MAX_BYTES);
    } catch {
      return BUG_REPORT_ERRORS.chatUnavailable;
    }
  }

  /** Exactly what a report would carry besides the description. */
  async function preview(input = {}) {
    const threadId = typeof input?.threadId === "string" && THREAD_ID.test(input.threadId) ? input.threadId : null;
    const [report, chat] = await Promise.all([
      diagnostics(BUG_REPORT_LOG_TAIL_BYTES),
      input?.includeChatLog === true && threadId ? chatLog(threadId) : null,
    ]);
    return {
      installId: installId(dataDir()),
      appVersion: String(appVersion).slice(0, 40),
      platform: String(platform).slice(0, 40),
      diagnostics: firstBytes(report, BUG_REPORT_TEXT_MAX_BYTES),
      ...(chat ? { chatLog: chat } : {}),
    };
  }

  async function send(input = {}) {
    const description = typeof input?.description === "string" ? input.description.trim().slice(0, BUG_REPORT_DESCRIPTION_MAX) : "";
    if (!description) return { ok: false, error: BUG_REPORT_ERRORS.empty };
    if (sending) return { ok: false, error: BUG_REPORT_ERRORS.busy };
    sending = true;
    try {
      const extras = await preview(input);
      const body = { ...extras, source: input.source === "bot" ? "bot" : "button", description };
      let response;
      try {
        response = await fetcher(`${cloud}/api/bug-reports`, {
          method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch {
        return { ok: false, error: BUG_REPORT_ERRORS.offline };
      }
      const data = await boundedJson(response);
      if (response.ok) {
        const id = typeof data?.id === "string" && data.id.trim() ? data.id.trim().slice(0, 64) : null;
        return id ? { ok: true, id } : { ok: false, error: BUG_REPORT_ERRORS.server };
      }
      return bugReportFailure(response.status, data, { headers: response.headers, withChat: "chatLog" in extras });
    } finally {
      sending = false;
    }
  }

  return { preview, send };
}

/** Both answer only the local server's own page, like every IPC that reads this computer. */
export function registerBugReportIpc(ipcMain, reporter) {
  ipcMain.handle("desktop:send-bug-report", localOnly("desktop:send-bug-report", (_event, input) => reporter.send(input)));
  ipcMain.handle("desktop:preview-bug-report", localOnly("desktop:preview-bug-report", (_event, input) => reporter.preview(input)));
}

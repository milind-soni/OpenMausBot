// What one @devs report carries to the MausBot team's endpoint (POST /api/bug-reports on the Cloud origin): the person's
// message, the bot's summary when it wrote one, and facts the server gathers itself. Never the conversation, never a
// file. Everything passes redactReportText, and every field stays inside the endpoint's limits.
import { isSecretName, mask, redactSecretsInText } from "./redact.ts";
import { clip, oneLine } from "./host/text-clip.ts";

/** The endpoint's limits, and ours inside them. The endpoint takes 10,000 description characters, 40 for appVersion and
 * platform, 262,144 for diagnostics and a 600 KB body. */
export const DEVS_REPORT_LIMITS = {
  description: 10_000, message: 3_000, summary: 2_000, seen: 3_000, steps: 2_000,
  field: 40, diagnostics: 48_000, problems: 20, problemChars: 300, logLines: 80, logLineChars: 400, body: 600 * 1024,
} as const;

/** The fields today's Admin reads for the person's address, and the reply-to one it is gaining; it ignores fields it
 * does not know, so both go. */
export const CONTACT_FIELDS = ["contactEmail", "contact"] as const;

export interface DevsReportPayload {
  installId: string;
  source: "bot";
  description: string;
  appVersion: string;
  platform: string;
  diagnostics: string;
  contactEmail?: string;
  contact?: string;
}

export interface BotSummary { wentWrong: string; seen?: string; steps?: string }

export interface ReportedBot {
  id: string;
  name: string;
  engine: string;
  instanceId: string;
  model: string;
  effort?: string;
  variant?: string;
  health?: string;
  apps?: string;
}

export interface DevsReportInput {
  installId: string;
  appVersion: string;
  platform: string;
  /** The operating system's name, release and architecture. */
  os: string;
  runsOn: string;
  node: string;
  uptimeSeconds: number;
  language?: string;
  now: number;
  threadId: string;
  messageId: string;
  groupId?: string;
  where: string;
  /** The person's message, @devs included. */
  message: string;
  /** Their words without the tag. */
  words: string;
  bots: ReportedBot[];
  summary?: { by: string; text: BotSummary };
  /** Why no bot wrote a summary. */
  noSummary?: string;
  problems: string[];
  log: string[];
  contactEmail?: string;
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>«»]+/gi;
const URL_MASK = "«redacted URL parameters»";
const AUTHORIZATION = /\b(authorization|proxy-authorization)(["']?\s*[:=]\s*["']?)([A-Za-z][A-Za-z0-9_-]*\s+[A-Za-z0-9._~+/=-]+|[A-Za-z0-9._~+/=-]{8,})/gi;
const COOKIE = /\b((?:set-)?cookie)(["']?\s*[:=]\s*)([^\r\n]+)/gi;

/** A URL keeps its scheme, host and path: credentials before the host, and its query and fragment, are masked. */
function redactUrl(url: string): string {
  const query = url.search(/[?#]/);
  const address = query < 0 ? url : url.slice(0, query);
  return address.replace(/^(https?:\/\/)[^/@]*@/i, "$1«redacted credentials»@") + (query < 0 ? "" : `?${URL_MASK}`);
}

/** The values of this server's own secret-named environment variables, wherever they appear. */
export function environmentSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env).flatMap(([name, value]) => (value && value.length >= 8 && isSecretName(name) ? [value] : []))
    .sort((a, b) => b.length - a.length);
}

/** The app's own redaction (key shapes, Bearer tokens, secret-named values, private keys, URL passwords, held secrets),
 * then any authorization or cookie header, URL credentials and parameters, and the server's own secret values. */
export function redactReportText(text: string, secrets: readonly string[] = environmentSecrets()): string {
  let out = text;
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join(mask(secret));
  out = out.replace(URL_IN_TEXT, (url: string, at: number, whole: string) => (whole.startsWith(URL_MASK, at + url.length) ? url : redactUrl(url)));
  out = out.replace(AUTHORIZATION, (_m, key: string, sep: string, value: string) => `${key}${sep}${mask(value)}`);
  out = out.replace(COOKIE, (_m, key: string, sep: string, value: string) => `${key}${sep}${mask(value.trim())}`);
  return redactSecretsInText(out);
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/** An address the endpoint accepts, lower-cased, or nothing: a bad one would refuse the whole report. */
export function contactAddress(value: string | null | undefined): string | undefined {
  const email = value?.trim().toLowerCase() ?? "";
  return email.length <= 254 && EMAIL.test(email) ? email : undefined;
}

const singleLine = (value: string) => oneLine(value.replace(/\p{Cc}+/gu, " "), DEVS_REPORT_LIMITS.field) || "unknown";
const iso = (at: number) => new Date(at).toISOString();
function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The start of `text` in at most `max` characters, cut at a line end. */
function firstChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max - 2);
  return `${text.slice(0, cut > 0 ? cut : max - 2)}\n…`;
}

function describe(input: DevsReportInput, redact: (text: string) => string): string {
  const field = (text: string | undefined, max: number) => (text ? clip(redact(text), max) : "");
  const words = field(input.words, DEVS_REPORT_LIMITS.message) || "(no words besides @devs)";
  const lines = [words, "", `What they wrote: ${field(input.message, DEVS_REPORT_LIMITS.message)}`, `Where: ${redact(input.where)}`, ""];
  if (input.summary) {
    const { by, text } = input.summary;
    lines.push(`${redact(by)}'s summary: ${field(text.wentWrong, DEVS_REPORT_LIMITS.summary)}`);
    if (text.seen?.trim()) lines.push("", `What ${redact(by)} saw: ${field(text.seen, DEVS_REPORT_LIMITS.seen)}`);
    if (text.steps?.trim()) lines.push("", `Steps to reproduce: ${field(text.steps, DEVS_REPORT_LIMITS.steps)}`);
  } else {
    lines.push(`No summary from a bot: ${input.noSummary ?? "none was written"}.`);
  }
  return clip(lines.join("\n"), DEVS_REPORT_LIMITS.description);
}

function diagnose(input: DevsReportInput, redact: (text: string) => string): string {
  const lines = [
    "OpenMausBot @devs report", `Sent: ${iso(input.now)}`, `App version: ${input.appVersion}`, `Runs on: ${input.runsOn}`,
    `OS: ${input.os}`, `Node: ${input.node}`, `Server uptime: ${duration(input.uptimeSeconds)}`,
    ...(input.language ? [`Language: ${input.language}`] : []), `Install: ${input.installId}`,
    "", "## Conversation", `Conversation: ${input.threadId}`, `Message: ${input.messageId}`, ...(input.groupId ? [`Group chat: ${input.groupId}`] : []),
    `Summary from a bot: ${input.summary ? `yes, by ${input.summary.by} (report_bug)` : `no, ${input.noSummary ?? "none was written"}`}`,
  ];
  for (const bot of input.bots) {
    lines.push(`Bot: ${bot.name} (${bot.id})`, `  Engine: ${bot.engine} (${bot.instanceId}), model ${bot.model || "default"}${bot.effort ? `, effort ${bot.effort}` : ""}${bot.variant ? `, variant ${bot.variant}` : ""}`);
    if (bot.health) lines.push(`  Engine status: ${bot.health}`);
    if (bot.apps) lines.push(`  Connected apps: ${bot.apps}`);
  }
  lines.push("", "## Recent problems in this conversation, newest last");
  const problems = input.problems.slice(-DEVS_REPORT_LIMITS.problems).map((line) => oneLine(redact(line), DEVS_REPORT_LIMITS.problemChars));
  lines.push(...(problems.length ? problems : ["(none)"]));
  lines.push("", "## Server warnings and errors, newest last");
  const log = input.log.slice(-DEVS_REPORT_LIMITS.logLines).map((line) => oneLine(redact(line), DEVS_REPORT_LIMITS.logLineChars));
  lines.push(...(log.length ? log : ["(none since the server started)"]));
  return firstChars(redact(lines.join("\n")), DEVS_REPORT_LIMITS.diagnostics);
}

export function buildDevsReport(input: DevsReportInput, secrets: readonly string[] = environmentSecrets()): DevsReportPayload {
  const redact = (text: string) => redactReportText(text, secrets);
  const contact = contactAddress(input.contactEmail);
  return {
    installId: input.installId,
    source: "bot",
    description: describe(input, redact),
    appVersion: singleLine(input.appVersion),
    platform: singleLine(input.platform),
    diagnostics: diagnose(input, redact),
    ...(contact ? Object.fromEntries(CONTACT_FIELDS.map((name) => [name, contact])) : {}),
  };
}

export function withoutContact(payload: DevsReportPayload): DevsReportPayload {
  const { contactEmail: _email, contact: _contact, ...rest } = payload;
  return rest;
}

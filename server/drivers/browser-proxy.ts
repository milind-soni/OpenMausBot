// Built-in browser MCP server — spawned inside a bot's agent process (via
// the "browser" integration). The browser itself is a WebContentsView in the
// Electron main process; this proxy forwards each tool call to the loopback
// host in front of it (electron/browser-host.cjs) and turns the reply into
// the text a model reads.
//
// Semantic, not visual: every action hands back a fresh accessibility
// snapshot — element refs (`b<id>`), roles and names — so the bot rarely
// needs a screenshot and never guesses coordinates. Refs are only valid until
// the page changes, which is why each action's result includes the next set.
//
// Speaks raw JSON-RPC 2.0 over stdio (house style: agents-proxy/phone-proxy).
// State comes from env, injected by the harness:
//   OMB_BROWSER_URL    loopback host, e.g. http://127.0.0.1:52144
//   OMB_BROWSER_TOKEN  capability scoped to this bot + browser profile
//   OMB_BOT_ID         which bot's tab to drive (one view per bot)
//   OMB_BROWSER_PROFILE named shared session the bot is pointed at ("" = own)
//   OMB_CONTROL_URL / OMB_CONTROL_TOKEN  who-is-driving endpoint: while the
//                      person holds the wheel in the panel, actions refuse
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";

import { safeBrowserUrl } from "../computer-observation.ts";
import { createControlClient } from "../control-client.ts";

const HOST = (process.env.OMB_BROWSER_URL ?? "").replace(/\/$/, "");
const TOKEN = process.env.OMB_BROWSER_TOKEN ?? "";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const PROFILE = process.env.OMB_BROWSER_PROFILE ?? "";
const control = createControlClient();

// ── what the host answers ────────────────────────────────────────────────
const elementSchema = z.object({
  ref: z.string().min(1),
  role: z.string().min(1),
  name: z.string().default("unnamed"),
  disabled: z.boolean().optional(),
  checked: z.union([z.boolean(), z.literal("mixed")]).optional(),
  value: z.string().optional(),
});
const pageSchema = z.object({
  url: z.string().default(""),
  title: z.string().default(""),
  elements: z.array(elementSchema).default([]),
  /** Playwright-style ARIA snapshot with [ref=eN] refs; absent when the surface fell back to the bare tree */
  yaml: z.string().nullable().optional(),
  /** what the surface did or noticed on the bot's behalf: answered dialogs, off-screen content */
  notes: z.array(z.string()).default([]),
});
const stateSchema = z.object({ url: z.string().default(""), title: z.string().default(""), loading: z.boolean().optional() });
const screenshotSchema = z.object({ png: z.string().min(1), format: z.string().optional() });
const hostErrorSchema = z.object({ error: z.string().min(1) });

export type ObservedElement = z.infer<typeof elementSchema>;
export type ObservedPage = Omit<z.infer<typeof pageSchema>, "notes" | "yaml"> & { notes?: string[]; yaml?: string | null };

// ── what the model sends ─────────────────────────────────────────────────
const refSchema = z.string().trim().min(1, "a ref from browser_snapshot is required");
const navigateArgs = z.object({ url: z.string().trim().min(1, "a url is required") });
const clickArgs = z.object({ ref: refSchema, double: z.boolean().optional() });
const fillArgs = z.object({ ref: refSchema, text: z.string().max(4_000).default("") });
const typeArgs = z.object({ text: z.string().min(1, "text is required").max(4_000) });
const pressArgs = z.object({ key: z.string().trim().min(1, "a key is required") });
const scrollArgs = z.object({
  direction: z.enum(["up", "down", "left", "right"]).default("down"),
  amount: z.number().int().min(1).max(5_000).optional(),
});
const hoverArgs = z.object({ ref: refSchema });
const dragArgs = z.object({ from: refSchema, to: refSchema });
const selectArgs = z.object({
  ref: refSchema,
  values: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
});
const waitArgs = z.object({
  text: z.string().trim().min(1).optional(),
  url: z.string().trim().min(1).optional(),
  timeout_ms: z.number().int().min(250).max(30_000).optional(),
}).refine((value) => Boolean(value.text || value.url), { message: "text or url is required" });
const readSchema = z.object({ url: z.string().default(""), title: z.string().default(""), text: z.string().default(""), truncated: z.boolean().optional() });
const rpcMessageSchema = z.object({
  id: z.unknown().optional(),
  method: z.string().optional(),
  params: z.object({ name: z.string().optional(), arguments: z.unknown().optional(), protocolVersion: z.string().optional() }).optional(),
});

// ── sign-in and verification walls ──────────────────────────────────────
// The bot must never type a password or solve a challenge; the person does
// that in the Browser panel and hands control back. Detection is a hint on
// the observed page, not a gate: a login form embedded in a page the bot can
// still use stays usable.
const WALL_URL = /(^|[./])(login|signin|sign-in|sign_in|log-in|auth|sso|oauth|authorize|mfa|2fa|otp|verify|challenge|captcha|checkpoint)([./?#]|$)/i;
const WALL_HOST = /(accounts\.google\.com|login\.microsoftonline\.com|appleid\.apple\.com|auth0\.com|okta\.com|challenges\.cloudflare\.com)/i;
/** A title that IS the sign-in step, not one that mentions logging in. */
const WALL_TITLE = /^(sign in|sign-in|log in|log-in|login|signin|verify|verification|two-factor|2-step|authenticate)\b/i;
const WALL_BODY = /textbox "?[^"\n]*(password|passcode|one-time|verification code|security code)|(hcaptcha|recaptcha|turnstile|cf-challenge|press and hold|verify you are human)/i;

export type WallKind = "sign-in" | "verification";

/** Does this page want something only the person can give? */
export function classifyWall(page: { url: string; title: string; yaml?: string | null; elements?: ObservedElement[] }): WallKind | null {
  const body = page.yaml ?? (page.elements ?? []).map((element) => `${element.role} "${element.name}"`).join("\n");
  let host = "";
  try {
    host = new URL(page.url).host;
  } catch {
    host = "";
  }
  const verification = /(just a moment|verify you are human|attention required|are you a robot|security check|checking your browser|captcha)/i.test(page.title)
    || /(hcaptcha|recaptcha|turnstile|cf-challenge|press and hold|verify you are human)/i.test(body)
    || /challenges\.cloudflare\.com/i.test(host);
  if (verification) return "verification";
  // a password/one-time-code field anywhere is the strongest signal; a
  // sign-in host, or a sign-in URL whose title says so, are the others
  const signIn = WALL_BODY.test(body) || WALL_HOST.test(host) || (WALL_URL.test(page.url) && WALL_TITLE.test(page.title.trim()));
  return signIn ? "sign-in" : null;
}

function wallNote(kind: WallKind): string {
  return kind === "verification"
    ? "This looks like a bot check or verification page. Do not try to solve it: call browser_request_takeover so the user can complete it in the Browser panel, then continue from the page you get back."
    : "This looks like a sign-in step. Never type the user's password or a one-time code: call browser_request_takeover so they can sign in in the Browser panel, then continue from the page you get back.";
}

const PROTECTED_FIELD_NAME = /\b(password|passwd|passcode|client[ _-]?secret|api[ _-]?key|secret[ _-]?key|private[ _-]?key|signing[ _-]?key|webhook[ _-]?secret|(?:aws[ _-]?)?secret[ _-]?access[ _-]?key|access[ _-]?token|auth[ _-]?token|refresh[ _-]?token|bearer[ _-]?token|one[ _-]?time(?:[ _-]?code)?|verification[ _-]?code|security[ _-]?(?:code|answer)|recovery[ _-]?(?:code|phrase)|seed[ _-]?phrase|mnemonic|otp|pin|card[ _-]?(?:number|security|cvv|cvc)|cvv|cvc|bank[ _-]?(?:account|routing)|routing[ _-]?(?:number|code)|account[ _-]?(?:number|no)|social[ _-]?(?:security|insurance)|ssn|tax[ _-]?id)\b/i;

/** Defense in depth for mixed-version/dev setups: even if an older Electron
 * surface includes a protected field's current value, the proxy strips it
 * before model context or the transcript can see it. */
function redactProtectedSnapshot(page: ObservedPage): ObservedPage {
  const elements = page.elements.map((element) =>
    PROTECTED_FIELD_NAME.test(element.name) && element.value !== undefined
      ? { ...element, value: undefined }
      : element
  );
  const yaml = page.yaml == null
    ? page.yaml
    : page.yaml
      .split("\n")
      .map((line) =>
        PROTECTED_FIELD_NAME.test(line) && /\b(?:textbox|searchbox|combobox)\b/i.test(line)
          ? line.replace(/(\[ref=[^\]]+\])(?::.*)?$/, "$1")
          : line
      )
      .join("\n");
  return { ...page, elements, yaml };
}

/** The page as the model reads it. URLs are scrubbed of query and fragment
 * before they reach a transcript (session tokens ride in both); the host
 * keeps the real one. */
export function formatObserved(page: ObservedPage): string {
  page = redactProtectedSnapshot(page);
  const url = safeBrowserUrl(page.url) ?? (page.url === "about:blank" ? "about:blank" : "URL unavailable");
  const wall = classifyWall(page);
  const notes = [...(page.notes ?? []), ...(wall ? [wallNote(wall)] : [])];
  if (page.yaml !== undefined && page.yaml !== null) {
    return [`Browser — ${page.title || "Untitled"}: ${url}`, page.yaml || "(empty page)", ...notes].join("\n");
  }
  const lines = page.elements.map((element) => {
    const flags = [
      element.disabled ? "disabled" : "",
      element.checked === true ? "checked" : element.checked === "mixed" ? "mixed" : "",
      element.value !== undefined ? `value=${JSON.stringify(element.value)}` : "",
    ].filter(Boolean);
    return `${element.ref} ${element.role} ${JSON.stringify(element.name)}${flags.length ? ` (${flags.join(", ")})` : ""}`;
  });
  return [`Browser — ${page.title || "Untitled"}: ${url}`, lines.join("\n") || "No interactive elements found.", ...notes].join("\n");
}

export type HostRequest = (operation: string, body?: object) => Promise<unknown>;

/** Give long-poll operations enough transport headroom beyond the duration
 * the host itself is allowed to wait. Without this, a valid 30-second
 * browser_wait_for was aborted by the proxy's fixed 20-second deadline. */
export function browserHostTimeoutMs(operation: string, body: object = {}): number {
  if (operation === "navigate") return 30_000;
  if (operation === "wait") {
    const requested = (body as { timeoutMs?: unknown }).timeoutMs;
    const waitMs = typeof requested === "number" && Number.isFinite(requested)
      ? Math.max(250, Math.min(30_000, requested))
      : 10_000;
    return Math.max(20_000, waitMs + 5_000);
  }
  return 20_000;
}

/** One round trip to the browser host. A non-2xx reply carries the host's
 * own sentence (stale ref, refused address, no previous page) — that text
 * is exactly what the model should read, so it is thrown as-is. */
export async function hostRequest(operation: string, body: object = {}, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  if (!HOST || !TOKEN || !BOT_ID) throw new Error("the built-in browser is not connected for this bot");
  const res = await fetchImpl(`${HOST}/v1/bots/${encodeURIComponent(BOT_ID)}/${operation}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ ...body, profile: PROFILE }),
    signal: AbortSignal.timeout(browserHostTimeoutMs(operation, body)),
  });
  const parsed: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const failure = hostErrorSchema.safeParse(parsed);
    throw new Error(failure.success ? failure.data.error : `browser host: HTTP ${res.status}`);
  }
  return parsed;
}

const REF_PROPERTY = { type: "string", description: "An element ref from the latest browser_snapshot, such as b123." } as const;

export const TOOLS = [
  {
    name: "browser_navigate",
    description:
      "Open a web address in this bot's built-in browser tab (the user can watch it in the Browser panel). Returns the page's interactive elements with refs — do not follow it with browser_snapshot.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "http(s) address; the scheme may be omitted." } }, required: ["url"] },
  },
  {
    name: "browser_snapshot",
    description:
      "Read the current page's interactive elements (links, buttons, fields, headings) as refs. Prefer this over screenshots; refs expire whenever the page changes, so take a fresh one after anything you did not do yourself.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description: "Click one element ref. Returns the resulting page's elements.",
    inputSchema: {
      type: "object",
      properties: { ref: REF_PROPERTY, double: { type: "boolean", description: "Double-click instead of a single click." } },
      required: ["ref"],
    },
  },
  {
    name: "browser_fill",
    description: "Replace the text of one field ref with new text, then return the page. Never enter passwords, payment details, or one-time codes — ask the user to do that in the Browser panel.",
    inputSchema: { type: "object", properties: { ref: REF_PROPERTY, text: { type: "string", maxLength: 4000 } }, required: ["ref", "text"] },
  },
  {
    name: "browser_type",
    description: "Type text into whatever currently has focus (after a browser_click on a field). Use browser_fill to replace a field's contents.",
    inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 4000 } }, required: ["text"] },
  },
  {
    name: "browser_press",
    description: "Press one key: enter, tab, escape, backspace, delete, space, arrowup, arrowdown, arrowleft, arrowright, pageup, pagedown, home, end.",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "browser_scroll",
    description: "Scroll the page.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "integer", minimum: 1, maximum: 5000, description: "Pixels, default 600." },
      },
      required: ["direction"],
    },
  },
  {
    name: "browser_hover",
    description: "Move the pointer over one element ref (opens hover menus, reveals tooltips). Returns the page.",
    inputSchema: { type: "object", properties: { ref: REF_PROPERTY }, required: ["ref"] },
  },
  {
    name: "browser_drag",
    description: "Drag one element ref onto another.",
    inputSchema: { type: "object", properties: { from: REF_PROPERTY, to: REF_PROPERTY }, required: ["from", "to"] },
  },
  {
    name: "browser_select_option",
    description: "Choose one or more options in a select (dropdown) field ref, by option value or visible label.",
    inputSchema: {
      type: "object",
      properties: {
        ref: REF_PROPERTY,
        values: { type: "array", items: { type: "string" }, minItems: 1, description: "Option values or labels; several only for a multi-select." },
      },
      required: ["ref", "values"],
    },
  },
  {
    name: "browser_wait_for",
    description:
      "Wait until text appears on the page and/or the address contains something, then return the page. Bounded by timeout_ms (default 10000, max 30000).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Visible text to wait for." },
        url: { type: "string", description: "A substring the address must contain." },
        timeout_ms: { type: "integer", minimum: 250, maximum: 30000 },
      },
      anyOf: [{ required: ["text"] }, { required: ["url"] }],
    },
  },
  {
    name: "browser_read",
    description:
      "Read the page's visible text (articles, results, tables) as plain text — for understanding content, not for acting. Use browser_snapshot for things to click.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_back",
    description: "Go back to the previous page.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_forward",
    description: "Go forward to the next page.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_request_takeover",
    description:
      "Ask the user to take over the browser for a sign-in, password, one-time code, CAPTCHA, or any step you must not do yourself, then wait until they hand control back. Returns the page as it is afterwards. Never enter credentials or solve challenges yourself.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string", maxLength: 240, description: "One short sentence: what you need them to do." } },
      required: ["reason"],
    },
  },
  {
    name: "browser_state",
    description: "The current page's title and address, without elements. Cheap; use it to confirm where you are.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_screenshot",
    description: "See the page as an image. Only when the element list is not enough (layout, charts, visual state).",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };

function textResult(text: string, isError = false): ToolResult {
  const result: ToolResult = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
}

/** The first problem a schema found, as one sentence the model can act on. */
function argumentError(tool: string, error: z.ZodError): ToolResult {
  const issue = error.issues[0];
  const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
  return textResult(`${tool}: ${issue?.message ?? "invalid arguments"}${where}`, true);
}

const TAKEOVER_WAIT_MS = 10 * 60_000;
const TAKEOVER_POLL_MS = 1_500;
const takeoverArgs = z.object({ reason: z.string().trim().min(1, "say what the user should do").max(240) });

/** Page the person, then wait for the hand-back — the same choreography the
 * computer proxy uses. Reads stay allowed meanwhile; actions refuse. */
async function requestTakeover(reason: string, request: HostRequest, waitMs = TAKEOVER_WAIT_MS, pollMs = TAKEOVER_POLL_MS): Promise<ToolResult> {
  if (!control.configured) {
    return textResult("Nobody can be paged for this browser right now. Tell the user in chat what you need them to do in the Browser panel.", true);
  }
  const initial = await control.state(true);
  // if the person is already driving, don't clobber whatever plea they are reading
  const requestId = initial.held ? null : await control.requestHelp(reason);
  if (!initial.held && requestId === null) {
    return textResult("The user could not be paged right now. Tell them in chat what you need them to do in the Browser panel.", true);
  }
  let sawHold = initial.held;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const state = await control.state(true);
    if (state.held) sawHold = true;
    if (!state.held && !state.helpOpen) {
      const page = await observed(request, "snapshot");
      const lead = sawHold
        ? "The user has finished and handed control back. Here is the page as it is now — continue from it, and never repeat what they did."
        : "The user dismissed the request without taking control. Carry on yourself if you can, or ask them in chat.";
      return { content: [{ type: "text", text: `${lead}\n\n${page.content[0]?.type === "text" ? page.content[0].text : ""}` }] };
    }
  }
  if (requestId) await control.expireHelp(requestId);
  return textResult("Nobody took control within the wait window. Tell the user in chat what you need, then try again when they are ready.", true);
}

const BROWSER_CONTROL_REFUSAL =
  "A person has taken control of this browser, so nothing was read or changed. " +
  "Do not inspect, screenshot, or retry while they may be typing private information. " +
  "Call browser_request_takeover to wait for them to hand control back.";

async function observed(request: HostRequest, operation: string, body?: object): Promise<ToolResult> {
  return textResult(formatObserved(pageSchema.parse(await request(operation, body))));
}

export async function callTool(name: string, args: unknown, request: HostRequest = hostRequest): Promise<ToolResult> {
  // The person driving in the panel wins. Reads are private too: a snapshot
  // or screenshot taken while they enter a password would leak it straight
  // into model context. Only the takeover wait choreography remains open.
  if (name !== "browser_request_takeover" && (await control.state(true)).held) {
    return textResult(BROWSER_CONTROL_REFUSAL, true);
  }
  if (name === "browser_navigate") {
    const parsed = navigateArgs.safeParse(args);
    if (!parsed.success) return argumentError(name, parsed.error);
    return observed(request, "navigate", { url: parsed.data.url });
  }
  if (name === "browser_snapshot") return observed(request, "snapshot");
  if (name === "browser_click") {
    const parsed = clickArgs.safeParse(args);
    if (!parsed.success) return argumentError(name, parsed.error);
    return observed(request, "click", { ref: parsed.data.ref, double: parsed.data.double === true });
  }
  if (name === "browser_fill") {
    const parsed = fillArgs.safeParse(args);
    if (!parsed.success) return argumentError(name, parsed.error);
    return observed(request, "fill", { ref: parsed.data.ref, text: parsed.data.text });
  }
  if (name === "browser_type") {
    const parsed = typeArgs.safeParse(args);
    if (!parsed.success) return argumentError(name, parsed.error);
    return observed(request, "type", { text: parsed.data.text });
  }
  if (name === "browser_press") {
    const parsed = pressArgs.safeParse(args);
    if (!parsed.success) return argumentError(name, parsed.error);
    return observed(request, "press", { key: parsed.data.key });
  }
  if (name === "browser_scroll") {
    const parsed = scrollArgs.safeParse(args ?? {});
    if (!parsed.success) return argumentError(name, parsed.error);
    return observed(request, "scroll", parsed.data);
  }
  if (name === "browser_hover") {
    const parsed = hoverArgs.safeParse(args);
    if (!parsed.success) return argumentError(name, parsed.error);
    return observed(request, "hover", { ref: parsed.data.ref });
  }
  if (name === "browser_drag") {
    const parsed = dragArgs.safeParse(args);
    if (!parsed.success) return argumentError(name, parsed.error);
    return observed(request, "drag", { from: parsed.data.from, to: parsed.data.to });
  }
  if (name === "browser_select_option") {
    const parsed = selectArgs.safeParse(args);
    if (!parsed.success) return argumentError(name, parsed.error);
    const values = Array.isArray(parsed.data.values) ? parsed.data.values : [parsed.data.values];
    return observed(request, "select", { ref: parsed.data.ref, values });
  }
  if (name === "browser_wait_for") {
    const parsed = waitArgs.safeParse(args);
    if (!parsed.success) return argumentError(name, parsed.error);
    const body: { text?: string; url?: string; timeoutMs?: number } = {};
    if (parsed.data.text) body.text = parsed.data.text;
    if (parsed.data.url) body.url = parsed.data.url;
    if (parsed.data.timeout_ms) body.timeoutMs = parsed.data.timeout_ms;
    return observed(request, "wait", body);
  }
  if (name === "browser_read") {
    const page = readSchema.parse(await request("read"));
    const url = safeBrowserUrl(page.url) ?? (page.url === "about:blank" ? "about:blank" : "URL unavailable");
    if (!page.text.trim()) return textResult(`${page.title || "Untitled"}: ${url}\n(The page has no readable text.)`);
    return textResult(`${page.title || "Untitled"}: ${url}\n\n${page.text}`);
  }
  if (name === "browser_back") return observed(request, "back");
  if (name === "browser_forward") return observed(request, "forward");
  if (name === "browser_request_takeover") {
    const parsed = takeoverArgs.safeParse(args);
    if (!parsed.success) return argumentError(name, parsed.error);
    return requestTakeover(parsed.data.reason, request);
  }
  if (name === "browser_state") {
    const state = stateSchema.parse(await request("state"));
    if (!state.url || state.url === "about:blank") return textResult("The browser tab is empty. Use browser_navigate to open a page.");
    return textResult(`${state.title || "Untitled"}: ${safeBrowserUrl(state.url) ?? "URL unavailable"}${state.loading === true ? " (still loading)" : ""}`);
  }
  if (name === "browser_screenshot") {
    const shot = screenshotSchema.parse(await request("screenshot"));
    const mime = shot.format === "png" ? "image/png" : "image/jpeg";
    return { content: [{ type: "text", text: "Current browser page" }, { type: "image", data: shot.png, mimeType: mime }] };
  }
  return textResult(`Unknown tool: ${name}`, true);
}

const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(line: string) {
  const parsed = rpcMessageSchema.safeParse(JSON.parse(line));
  if (!parsed.success) return;
  const { id, method, params } = parsed.data;
  if (method === "initialize") {
    return ok(id, {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "openmausbot-browser", version: "1" },
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name ?? "";
    if (!TOOLS.some((tool) => tool.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
    try {
      return ok(id, await callTool(name, params?.arguments ?? {}));
    } catch (error) {
      return ok(id, textResult(error instanceof Error ? error.message : String(error), true));
    }
  }
  if (id !== undefined) rpcError(id, -32601, `Method not found: ${String(method)}`);
}

if (process.argv[1] && existsSync(process.argv[1]) && /browser-proxy\.(?:ts|js)$/.test(process.argv[1])) {
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    handle(line).catch((error) => {
      let id: unknown;
      try {
        id = rpcMessageSchema.parse(JSON.parse(line)).id;
      } catch {
        return;
      }
      rpcError(id, -32603, error instanceof Error ? error.message : String(error));
    });
  });
  lines.on("close", () => process.exit(0));
}

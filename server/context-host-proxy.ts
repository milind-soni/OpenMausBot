// Loopback reverse proxy in front of a local inference host (oMLX, Ollama,
// LM Studio, Unsloth, EXO). The OpenMausBot / Grok ACP session is left
// alone. After compaction, this proxy rewrites chat/completions so the
// *provider* sees a fresh context: system messages + state vector + the
// current user turn (and any tool follow-ups after it).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  appendMidTaskContinuitySystem,
  clipCompactUserText,
  compactedProviderUserTurns,
  COMPACT_USER_CLIP_CHARS,
  MID_TASK_CONTINUITY_SYSTEM,
  stubBulkPadText,
} from "./context-compact.ts";
import { decodeInjectId, hostApiKey, localHost } from "./drivers/local-inject.ts";

const AUTH_PREFIX = "ombv1.";

export interface ChatMessage {
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

export interface HostRewrite {
  targetBaseUrl: string;
  apiKey: string;
  vector: string | null;
  userText: string;
}

function messageText(message: ChatMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

export function encodeProxyAuth(threadId: string, apiKey: string): string {
  return `${AUTH_PREFIX}${threadId}.${apiKey}`;
}

export function decodeProxyAuth(header: string | undefined): { threadId: string | null; apiKey: string } {
  const raw = (header ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!raw.startsWith(AUTH_PREFIX)) return { threadId: null, apiKey: raw };
  const rest = raw.slice(AUTH_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return { threadId: null, apiKey: raw };
  return { threadId: rest.slice(0, dot), apiKey: rest.slice(dot + 1) };
}

/** True when `content` is the compact-turn user message (or a truncated copy
 * of it). A later short prompt that merely repeats a word from that turn
 * must not match — that used to drop the post-refresh tail. */
export function messageMatchesCompactNeedle(content: string, needle: string): boolean {
  const text = content.trim();
  const n = needle.trim();
  if (!text || !n) return false;
  if (text === n || text.includes(n)) return true;
  if (text.length < 80) return false;
  if (!n.startsWith(text) && !n.includes(text)) return false;
  return text.length >= n.length * 0.5;
}

function withMidTaskContinuity(prefix: ChatMessage[]): ChatMessage[] {
  if (prefix.length === 0) {
    return [{ role: "system", content: MID_TASK_CONTINUITY_SYSTEM }];
  }
  const last = prefix[prefix.length - 1]!;
  const content = messageText(last);
  return [
    ...prefix.slice(0, -1),
    { ...last, content: appendMidTaskContinuitySystem(content) },
  ];
}

/** Keep system/developer (+ mid-task continuity), inject vector, keep from live ask onward.
 * Shared shape with Grok/openai-chat compacted path via compactedProviderUserTurns. */
export function rewriteOpenAIMessages(messages: ChatMessage[], vector: string, userText: string): ChatMessage[] {
  const prefix = withMidTaskContinuity(
    messages.filter((message) => {
      const role = typeof message.role === "string" ? message.role : "";
      return role === "system" || role === "developer";
    }),
  );
  const { vector: stateVector, liveAsk } = compactedProviderUserTurns(vector, userText);
  // Bare vector — no "Current task state" framing (models echo/narrate it).
  const state: ChatMessage = { role: "user", content: stateVector };
  const needle = userText.trim();
  let start = -1;
  if (needle) {
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.role !== "user") continue;
      if (messageMatchesCompactNeedle(messageText(messages[i]!), needle)) {
        start = i;
        break;
      }
    }
  }
  if (start < 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        start = i;
        break;
      }
    }
  }
  let suffix = (start >= 0 ? messages.slice(start) : []).filter((message) => {
    const role = typeof message.role === "string" ? message.role : "";
    return role !== "system" && role !== "developer";
  });
  // If the needle was missing from history, still emit the live ask as its own user turn.
  if (suffix.length === 0 && liveAsk) {
    suffix = [{ role: "user", content: liveAsk }];
  }
  // Only the compact-turn needle is stubbed/clipped for the provider. Later
  // fat pastes must stay full so fill/SPT can climb again and a second
  // compact can fire — clipping every oversized suffix turn froze the chip
  // ~post-refresh size and blocked multi-compact.
  const clippedSuffix = suffix.map((message, index) => {
    if (message.role !== "user") return message;
    const text = messageText(message);
    if (needle && messageMatchesCompactNeedle(text, needle)) {
      return { ...message, content: liveAsk || clipCompactUserText(stubBulkPadText(text)) };
    }
    if (index === 0 && liveAsk && text.trim() === needle) {
      return { ...message, content: liveAsk };
    }
    if (text.length <= COMPACT_USER_CLIP_CHARS) return message;
    return message;
  });
  return [...prefix, state, ...clippedSuffix];
}

export function rewriteOpenAIChatBody(raw: string, vector: string, userText: string): string {
  let parsed: { messages?: unknown };
  try {
    parsed = JSON.parse(raw) as { messages?: unknown };
  } catch {
    return raw;
  }
  if (!Array.isArray(parsed.messages)) return raw;
  parsed.messages = rewriteOpenAIMessages(parsed.messages as ChatMessage[], vector, userText);
  return JSON.stringify(parsed);
}

export function forwardUrl(targetBaseUrl: string, incomingPath: string): string {
  const target = new URL(targetBaseUrl.includes("://") ? targetBaseUrl : `http://${targetBaseUrl}`);
  const origin = `${target.protocol}//${target.host}`;
  const [path, query] = (incomingPath || "/").split("?");
  const suffix = query ? `?${query}` : "";
  if (path.startsWith("/v1")) return `${origin}${path}${suffix}`;
  const prefix = (target.pathname.replace(/\/$/, "") || "/v1");
  const rest = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${prefix}${rest}${suffix}`;
}

function shouldRewrite(method: string, path: string): boolean {
  return method === "POST" && /chat\/completions|\/messages$/.test(path.split("?")[0] ?? "");
}

export class HostProxy {
  private server: ReturnType<typeof createServer> | null = null;
  private port: number | null = null;
  private readonly slots = new Map<string, HostRewrite>();

  bind(threadId: string, rewrite: HostRewrite): void {
    this.slots.set(threadId, rewrite);
  }

  get(threadId: string): HostRewrite | undefined {
    return this.slots.get(threadId);
  }

  async ensureListening(): Promise<string> {
    if (this.port) return `http://127.0.0.1:${this.port}/v1`;
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("host proxy failed to bind"));
          return;
        }
        this.port = address.port;
        this.server = server;
        resolve();
      });
      server.on("error", reject);
    });
    return `http://127.0.0.1:${this.port}/v1`;
  }

  routeFor(threadId: string): { baseUrl: string; authorization: string } | null {
    const slot = this.slots.get(threadId);
    if (!slot || this.port === null) return null;
    return {
      baseUrl: `http://127.0.0.1:${this.port}/v1`,
      authorization: encodeProxyAuth(threadId, slot.apiKey),
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const decoded = decodeProxyAuth(req.headers.authorization);
    const slot = decoded.threadId ? this.slots.get(decoded.threadId) : undefined;
    if (!slot) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "no host rewrite bound for this turn" } }));
      return;
    }
    const incomingPath = req.url || "/";
    const url = forwardUrl(slot.targetBaseUrl, incomingPath);
    let body: Buffer | string = raw;
    if (slot.vector && shouldRewrite(req.method ?? "GET", incomingPath)) {
      body = rewriteOpenAIChatBody(raw.toString("utf8"), slot.vector, slot.userText);
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || key === "host" || key === "content-length") continue;
      headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    headers.authorization = `Bearer ${decoded.apiKey || slot.apiKey}`;
    try {
      const upstream = await fetch(url, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
      const outHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, key) => {
        if (key === "transfer-encoding") return;
        outHeaders[key] = value;
      });
      res.writeHead(upstream.status, outHeaders);
      if (!upstream.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
      }
      res.end();
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  }
}

export const hostProxy = new HostProxy();

export function bindLocalHostRewrite(input: {
  threadId: string;
  modelId: string | null | undefined;
  vector: string | null;
  userText: string;
  env?: Record<string, string | undefined>;
}): void {
  const inject = decodeInjectId(input.modelId);
  if (!inject) return;
  const host = localHost(inject.host);
  if (!host) return;
  hostProxy.bind(input.threadId, {
    targetBaseUrl: host.baseUrl,
    apiKey: hostApiKey(host, input.env),
    vector: input.vector,
    userText: input.userText,
  });
}

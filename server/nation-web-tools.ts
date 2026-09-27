// NATION-managed web search and web reader for agent turns.
//
// Both run in the harness, never in the model's sandbox: the search provider
// credential belongs to NATION (API process env or /admin), members enter
// nothing, and the provider's identity never appears in tool output or
// errors. The reader fetches public pages itself, refusing anything that
// resolves to a private, loopback, link-local or metadata address at
// connect time (so a DNS answer cannot be swapped between check and use).
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { AppConfig } from "./config.ts";

export type SearchProviderKind = "brave" | "tavily" | "openrouter";
export const SEARCH_PROVIDERS: readonly SearchProviderKind[] = ["brave", "tavily", "openrouter"];

export interface SearchProvider {
  kind: SearchProviderKind;
  key: string;
  /** Endpoint base; an operator override (or a hermetic stand-in). */
  url: string;
  /** openrouter only: the web-enabled model used for search. */
  model?: string;
}

export interface SearchResult { title: string; url: string; snippet: string }
export interface SearchOutcome { results: SearchResult[]; summary?: string; costUsd?: number }
export interface ReadOutcome { url: string; title: string; text: string; truncated: boolean; contentType: string }

/** The one message a person or model ever sees for a search/reader failure. */
export class WebToolError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}
const UNAVAILABLE = "Web search is temporarily unavailable. Try again shortly, or use the browser.";

const DEFAULT_URLS: Record<SearchProviderKind, string> = {
  brave: "https://api.search.brave.com/res/v1",
  tavily: "https://api.tavily.com",
  openrouter: "https://openrouter.ai/api/v1",
};

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/** Which provider backs web search: the admin's saved choice, then the API
 * process environment, then NATION's own model provider (web plugin). */
export function searchProvider(cfg: Pick<AppConfig, "webSearch">, env: NodeJS.ProcessEnv = process.env): SearchProvider | null {
  const url = (kind: SearchProviderKind) => (trimmed(env.NATION_SEARCH_API_URL) ?? DEFAULT_URLS[kind]).replace(/\/+$/, "");
  const openrouter = (): SearchProvider | null => {
    const key = trimmed(env.OPENROUTER_API_KEY);
    return key ? {
      kind: "openrouter",
      key,
      url: (trimmed(env.OPENROUTER_API_URL) ?? DEFAULT_URLS.openrouter).replace(/\/+$/, ""),
      model: trimmed(env.NATION_SEARCH_MODEL) ?? "openai/gpt-4o-mini",
    } : null;
  };
  // 1. The admin's saved choice (/admin), which always wins.
  const saved = cfg.webSearch;
  if (saved?.provider === "openrouter") return openrouter();
  if (saved?.provider && trimmed(saved.apiKey)) return { kind: saved.provider, key: trimmed(saved.apiKey)!, url: url(saved.provider) };
  // 2. The API process environment.
  const envKind = trimmed(env.NATION_SEARCH_PROVIDER);
  if ((envKind === "brave" || envKind === "tavily") && trimmed(env.NATION_SEARCH_API_KEY)) {
    return { kind: envKind, key: trimmed(env.NATION_SEARCH_API_KEY)!, url: url(envKind) };
  }
  // 3. NATION API's own web search, unless the environment names another provider.
  return !envKind || envKind === "openrouter" ? openrouter() : null;
}

/** Admin-facing status: configured-or-not and which kind, never the key. */
export function webToolsStatus(cfg: Pick<AppConfig, "webSearch">, env: NodeJS.ProcessEnv = process.env) {
  const provider = searchProvider(cfg, env);
  return {
    search: { configured: Boolean(provider), provider: provider?.kind ?? null,
      source: cfg.webSearch?.apiKey ? "admin" : provider?.kind === "openrouter" ? "nation-api" : provider ? "environment" : null },
    reader: { configured: true },
    prices: webToolPrices(env),
  };
}

export function webToolPrices(env: NodeJS.ProcessEnv = process.env): { searchUsd: number; readUsd: number } {
  const price = (raw: string | undefined, fallback: number) => {
    const value = Number(raw);
    return raw !== undefined && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
  };
  return { searchUsd: price(env.NATION_SEARCH_PRICE_USD, 0.005), readUsd: price(env.NATION_READER_PRICE_USD, 0.001) };
}

const clip = (value: unknown, max: number) => (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim().slice(0, max);

function normalizeResults(items: unknown[], count: number): SearchResult[] {
  const results: SearchResult[] = [];
  for (const raw of items) {
    const item = raw as Record<string, unknown>;
    const url = clip(item?.url, 2_000);
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({ title: clip(item.title, 200) || url, url, snippet: clip(item.snippet ?? item.description ?? item.content, 500) });
    if (results.length >= count) break;
  }
  return results;
}

/** Run one search. Provider errors never escape verbatim. */
export async function webSearch(
  provider: SearchProvider,
  query: string,
  count = 8,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchOutcome> {
  const q = query.trim().slice(0, 400);
  if (!q) throw new WebToolError("Give web_search a query.", 400);
  const limit = Math.min(Math.max(Math.trunc(count) || 8, 1), 10);
  let response: Response;
  try {
    if (provider.kind === "brave") {
      response = await fetchImpl(`${provider.url}/web/search?${new URLSearchParams({ q, count: String(limit) })}`, {
        headers: { accept: "application/json", "x-subscription-token": provider.key },
        signal: AbortSignal.timeout(15_000),
      });
    } else if (provider.kind === "tavily") {
      response = await fetchImpl(`${provider.url}/search`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${provider.key}` },
        body: JSON.stringify({ query: q, max_results: limit, include_answer: true }),
        signal: AbortSignal.timeout(20_000),
      });
    } else {
      response = await fetchImpl(`${provider.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${provider.key}` },
        body: JSON.stringify({
          model: provider.model,
          plugins: [{ id: "web", max_results: limit }],
          messages: [{ role: "user", content: `Search the web for: ${q}\nReply with a short factual summary of what the top results say.` }],
          usage: { include: true },
        }),
        signal: AbortSignal.timeout(45_000),
      });
    }
  } catch {
    throw new WebToolError(UNAVAILABLE);
  }
  if (!response.ok) throw new WebToolError(response.status === 429 ? "Web search is busy right now. Try again in a moment." : UNAVAILABLE);
  let body: any;
  try { body = await response.json(); } catch { throw new WebToolError(UNAVAILABLE); }
  if (provider.kind === "brave") return { results: normalizeResults(body?.web?.results ?? [], limit) };
  if (provider.kind === "tavily") {
    return { results: normalizeResults(body?.results ?? [], limit), ...(clip(body?.answer, 1_500) ? { summary: clip(body.answer, 1_500) } : {}) };
  }
  const message = body?.choices?.[0]?.message;
  const citations = (Array.isArray(message?.annotations) ? message.annotations : [])
    .filter((item: any) => item?.type === "url_citation")
    .map((item: any) => ({ url: item.url_citation?.url, title: item.url_citation?.title, snippet: item.url_citation?.content }));
  const cost = Number(body?.usage?.cost);
  return {
    results: normalizeResults(citations, limit),
    ...(clip(message?.content, 1_500) ? { summary: clip(message.content, 1_500) } : {}),
    ...(Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
  };
}

// ── reader ─────────────────────────────────────────────────────────────

function ipv4Private(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

/** The eight 16-bit groups of an IPv6 address in any spelling (compressed,
 * expanded, with a trailing dotted IPv4, with a zone), or null. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().replace(/%.*$/, "");
  const dotted = text.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((octet) => octet > 255)) return null;
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? fill : 0 }, () => "0"), ...tail];
  return groups.every((group) => /^[0-9a-f]{1,4}$/.test(group)) ? groups.map((group) => parseInt(group, 16)) : null;
}

const ipv4Of = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

/** Addresses the reader must never connect to. */
export function blockedAddress(address: string, allowLoopback = false): boolean {
  const family = isIP(address);
  if (family === 4) {
    if (allowLoopback && address.startsWith("127.")) return false;
    return ipv4Private(address);
  }
  if (family === 6) {
    // Compared by value, not by spelling: ::ffff:7f00:1 is 127.0.0.1 too.
    const groups = ipv6Groups(address);
    if (!groups) return true;
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
    const zeros = (count: number) => groups.slice(0, count).every((group) => group === 0);
    if (zeros(7) && g7 === 1) return !allowLoopback;
    // :: and the retired IPv4-compatible ::a.b.c.d
    if (zeros(6)) return true;
    // IPv4-mapped ::ffff:a.b.c.d and IPv4-translated ::ffff:0:a.b.c.d reach that IPv4 address
    if ((zeros(5) && g5 === 0xffff) || (zeros(4) && g4 === 0xffff && g5 === 0)) return blockedAddress(ipv4Of(g6, g7), allowLoopback);
    // 6to4 routes to the IPv4 address in its prefix
    if (g0 === 0x2002) return blockedAddress(ipv4Of(g1, g2));
    return (g0 & 0xfe00) === 0xfc00 // unique local
      || (g0 & 0xffc0) === 0xfe80 // link-local
      || (g0 & 0xffc0) === 0xfec0 // site-local
      || (g0 & 0xff00) === 0xff00 // multicast
      || (g0 === 0x64 && g1 === 0xff9b) // NAT64
      || (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) // Teredo, documentation
      || (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0); // discard-only
  }
  return true;
}

const READ_BYTES = 2 * 1024 * 1024;
const READ_CHARS = 20_000;
const TEXT_TYPES = /^(text\/(html|plain|markdown|xml|csv)|application\/(xhtml\+xml|json|xml|rss\+xml|atom\+xml))/i;

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

/** Readable text from HTML: scripts, styles and markup removed. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const body = html
    .replace(/<(script|style|noscript|template|svg|head|title)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body).split("\n").map((line) => line.replace(/[ \t\f\v\r]+/g, " ").trim()).filter(Boolean).join("\n");
  return { title, text };
}

function getOnce(target: URL, allowLoopback: boolean): Promise<IncomingMessage> {
  const guardedLookup = (hostname: string, options: any, callback: any) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[] | string) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: isIP(addresses) }];
      if (!list.length || list.some((item) => blockedAddress(item.address, allowLoopback))) {
        return callback(Object.assign(new Error("blocked address"), { code: "EBLOCKED" }));
      }
      return options?.all ? callback(null, list) : callback(null, list[0].address, list[0].family);
    });
  };
  const literal = isIP(target.hostname.replace(/^\[|\]$/g, ""));
  if (literal && blockedAddress(target.hostname.replace(/^\[|\]$/g, ""), allowLoopback)) {
    return Promise.reject(Object.assign(new Error("blocked address"), { code: "EBLOCKED" }));
  }
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(target, {
      method: "GET",
      lookup: guardedLookup,
      headers: { "user-agent": "NATION-Reader/1.0", accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
      timeout: 15_000,
    }, resolve);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** Fetch one public page as readable text. */
export async function webRead(rawUrl: string, options: { allowLoopback?: boolean } = {}): Promise<ReadOutcome> {
  let target: URL;
  try { target = new URL(rawUrl.trim()); } catch { throw new WebToolError("Give web_read a full http(s) URL.", 400); }
  const refused = () => new WebToolError("That address can't be read from here. Use a public web page, or open it in the browser.", 400);
  for (let hop = 0; hop < 5; hop++) {
    if (!/^https?:$/.test(target.protocol) || target.username || target.password) throw refused();
    let response: IncomingMessage;
    try {
      response = await getOnce(target, options.allowLoopback === true);
    } catch (error) {
      if ((error as { code?: string }).code === "EBLOCKED") throw refused();
      throw new WebToolError("That page couldn't be reached. Check the address, or try the browser.");
    }
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      target = new URL(response.headers.location, target);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new WebToolError(`That page answered with an error (${status}). Try another source or the browser.`);
    }
    const contentType = String(response.headers["content-type"] ?? "text/html");
    if (!TEXT_TYPES.test(contentType)) {
      response.resume();
      throw new WebToolError("That address isn't a readable page (it may be a file or media). Try the browser or a computer.", 415);
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let cut = false;
    for await (const chunk of response) {
      const buffer = chunk as Buffer;
      if (bytes + buffer.length > READ_BYTES) { chunks.push(buffer.subarray(0, READ_BYTES - bytes)); cut = true; response.destroy(); break; }
      chunks.push(buffer);
      bytes += buffer.length;
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const page = /html|xml/i.test(contentType) ? htmlToText(raw) : { title: "", text: raw.trim() };
    const truncated = cut || page.text.length > READ_CHARS;
    return { url: target.toString(), title: page.title.slice(0, 300), text: page.text.slice(0, READ_CHARS), truncated, contentType: contentType.split(";")[0] };
  }
  throw new WebToolError("That page redirected too many times.");
}

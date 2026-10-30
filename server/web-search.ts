import { request as httpsRequest } from "node:https";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { resolveTarget } from "./browser/egress/gate.ts";
import { addressClass, ownAddresses } from "./browser/egress/policy.ts";
import { configuredWebSearch, privateSearchAddress, searxngBase, type WebSearchConfig } from "./web-search-config.ts";

export const WEB_SEARCH_TIMEOUT_MS = 15_000;
export const WEB_SEARCH_MAX_BYTES = 1024 * 1024;
const publicV6 = new BlockList();
publicV6.addSubnet("2000::", 3, "ipv6");
const translatedV6 = new BlockList();
for (const [ip, bits] of [["2002::", 16], ["2001::", 23], ["2001:db8::", 32], ["3fff::", 20]] as const) translatedV6.addSubnet(ip, bits, "ipv6");
const reservedV4 = new BlockList();
for (const ip of ["192.0.0.0", "192.0.2.0", "192.88.99.0", "198.51.100.0", "203.0.113.0"]) reservedV4.addSubnet(ip, 24);

export interface WebSearchHit { title: string; url: string; snippet: string }

export function parseSearchResults(body: string, backend: "searxng" | "brave", limit: number): WebSearchHit[] {
  let data;
  try { data = JSON.parse(body); } catch { throw new Error("Web search returned invalid JSON."); }
  const rows: unknown = backend === "searxng" ? data?.results : data?.web?.results;
  if (!Array.isArray(rows)) throw new Error("Web search returned an unsupported JSON response.");
  const results: WebSearchHit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof row.url !== "string" || !row.url.trim() || row.url.length > 2048 || typeof row.title !== "string") continue;
    try {
      const url = new URL(row.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 2048 || seen.has(url.href)) continue;
      const title = row.title.trim().slice(0, 300);
      if (!title) continue;
      const snippet = backend === "searxng" ? row.content : row.description;
      seen.add(url.href);
      results.push({ title, url: url.href, snippet: typeof snippet === "string" ? snippet.trim().slice(0, 1000) : "" });
      if (results.length >= limit) break;
    } catch { continue; }
  }
  return results;
}

export interface WebSearchOptions {
  /** Test seams; the harness never accepts these from a bot or configuration. */
  assertAllowed?: () => void;
  resolve?: typeof resolveTarget;
  request?: typeof httpsRequest;
  timeoutMs?: number;
  maxBytes?: number;
}

function braveRetrySeconds(headers: IncomingHttpHeaders): number | undefined {
  const seconds = (value: string) => /^\d{1,10}$/.test(value.trim()) ? Number(value.trim()) : undefined;
  const after = headers["retry-after"];
  if (typeof after === "string") {
    const delay = seconds(after);
    if (delay !== undefined) return delay;
    const date = new Date(after.length === 29 ? after : "");
    if (Number.isFinite(date.getTime()) && date.toUTCString() === after) return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
  }
  const reset = headers["x-ratelimit-reset"];
  if (typeof reset !== "string" || reset.length > 256) return undefined;
  const resets = reset.split(",").map(seconds);
  if (resets.some(value => value === undefined)) return undefined;
  const remaining = headers["x-ratelimit-remaining"];
  const quotas = typeof remaining === "string" && remaining.length <= 256 ? remaining.split(",").map(seconds) : [];
  const exhausted = resets.filter((_value, index) => quotas.length !== resets.length || quotas.some(value => value === undefined) || quotas[index] === 0);
  return exhausted.length ? Math.max(...exhausted as number[]) : undefined;
}

export async function searchWeb(config: WebSearchConfig | undefined, query: string, limit = 5, signal?: AbortSignal, options: WebSearchOptions = {}): Promise<WebSearchHit[]> {
  const backend = configuredWebSearch(config);
  if (!backend) throw new Error("Web search is not configured. Configure SearXNG or Brave Search before using web search.");
  const url = backend === "searxng" ? new URL("search", searxngBase(config!.searxngUrl!)) : new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  if (backend === "searxng") url.searchParams.set("format", "json");
  else { url.searchParams.set("count", String(limit)); url.searchParams.set("text_decorations", "false"); }
  const expires = performance.now() + (options.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS);
  const deadline = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS), ...(signal ? [signal] : [])]);
  const check = () => {
    if (deadline.aborted || performance.now() >= expires) throw new Error("Web search stopped or timed out.");
  };
  check();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Web search stopped or timed out."));
    deadline.addEventListener("abort", onAbort, { once: true });
  });
  const run = async () => {
    options.assertAllowed?.();
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await (options.resolve ?? resolveTarget)(host);
    check();
    const own = ownAddresses();
    if (!addresses.length || addresses.some(({ address }) => backend === "brave"
      ? addressClass(address, own) !== "public" || (isIP(address) === 4 && reservedV4.check(address)) || (isIP(address) === 6 && (!publicV6.check(address, "ipv6") || translatedV6.check(address, "ipv6")))
      : url.protocol === "http:" && !privateSearchAddress(address))) {
      throw new Error(backend === "brave" ? "Web search destination is not public." : "SearXNG HTTP requires loopback or private addresses. Use HTTPS for public instances.");
    }
    options.assertAllowed?.();
    check();
    const address = addresses[0]!;
    const lookup: LookupFunction = (_host, settings, done) => {
      if (settings.all) done(null, [address]);
      else done(null, address.address, address.family);
    };
    const body = await new Promise<Buffer>((resolve, reject) => {
      const req = (options.request ?? (url.protocol === "http:" ? httpRequest : httpsRequest))(url, {
        agent: false, lookup, signal: deadline,
        headers: { "user-agent": "OpenMausBot/1.0 (web search)", accept: "application/json", "accept-encoding": "identity", ...(backend === "brave" ? { "X-Subscription-Token": config!.braveApiKey! } : {}) },
      }, response => {
        response.on("error", () => reject(new Error("Web search response was interrupted.")));
        if (backend === "brave" && (response.statusCode === 401 || response.statusCode === 403 || response.statusCode === 429)) {
          const delay = response.statusCode === 429 ? braveRetrySeconds(response.headers) : undefined;
          reject(new Error(response.statusCode === 429
            ? `Brave quota or rate limit reached. ${delay === undefined ? "Try again later or check your Brave API plan." : `Retry after ${delay} seconds.`}`
            : "The Brave key was rejected. Check your Brave Search API key."));
          response.destroy();
          return;
        }
        const contentType = response.headers["content-type"] ?? "";
        const parts = contentType.toLowerCase().split(";").map(part => part.trim());
        if (response.statusCode !== 200 || parts[0] !== "application/json" || parts.slice(1).some(part => { const [name, value] = part.split("=").map(value => value.trim()); return name === "charset" && value !== "utf-8" && value !== '"utf-8"'; }) ||
            (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")) {
          response.destroy();
          reject(new Error(backend === "searxng" && (response.statusCode === 403 || parts[0] === "text/html")
            ? "SearXNG JSON is disabled or access was denied. Enable json in search.formats in settings.yml."
            : "Web search is unavailable or did not return UTF-8 JSON."));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > (options.maxBytes ?? WEB_SEARCH_MAX_BYTES)) {
            reject(new Error("Web search response is too large.")); response.destroy();
          } else chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("aborted", () => reject(new Error("Web search response was interrupted.")));
      });
      req.on("error", () => reject(new Error("Web search could not be reached.")));
      req.end();
    });
    check();
    let decoded: string;
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(body); } catch { throw new Error("Web search returned invalid UTF-8."); }
    const results = parseSearchResults(decoded, backend, limit);
    check();
    return results;
  };
  try { return await Promise.race([run(), aborted]); }
  finally { deadline.removeEventListener("abort", onAbort); }
}

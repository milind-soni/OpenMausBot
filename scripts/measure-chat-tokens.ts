// Counts captured chat requests with a local tokenizer. These endpoints render
// and tokenize only; this script never calls a completion or changes a runner.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type ChatRequest = { messages: unknown[]; tools?: unknown[]; [key: string]: unknown };

export function localTokenizerUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !["/", "/v1", "/v1/"].includes(url.pathname)) {
    throw new Error("Supply an unauthenticated loopback tokenizer URL, with no path or /v1.");
  }
  url.pathname = "/";
  return url;
}

export async function measureChatRequests(requests: ChatRequest[], base: URL) {
  base = localTokenizerUrl(base.href);
  const post = async (path: string, body: unknown) => {
    const response = await fetch(new URL(path, base), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (!response.ok) throw new Error(`Tokenizer ${path} returned HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
  };
  let previous: number[] = [];
  const measurements = [];
  for (const [index, request] of requests.entries()) {
    if (!Array.isArray(request.messages)) throw new Error("A captured request must contain messages.");
    // Captures may name a fake provider model. The selected tokenizer's
    // loaded model determines the template and vocabulary for this comparison.
    const rendered = await post("apply-template", { ...request, model: undefined, add_generation_prompt: true });
    if (typeof rendered.prompt !== "string") throw new Error("Tokenizer did not return a rendered prompt.");
    const encoded = await post("tokenize", { content: rendered.prompt, add_special: false });
    if (!Array.isArray(encoded.tokens) || !encoded.tokens.every((token) => Number.isSafeInteger(token))) {
      throw new Error("Tokenizer did not return token IDs.");
    }
    const tokens = encoded.tokens as number[];
    let shared = 0;
    while (shared < Math.min(previous.length, tokens.length) && previous[shared] === tokens[shared]) shared += 1;
    measurements.push({
      request: index + 1, inputTokens: tokens.length, toolCount: request.tools?.length ?? 0,
      messageCount: request.messages.length, renderedBytes: Buffer.byteLength(rendered.prompt),
      ...(index ? { sharedPrefixTokens: shared, previousInputTokens: previous.length, newSuffixTokens: tokens.length - shared } : {}),
    });
    previous = tokens;
  }
  return { tokenizer: base.href, method: "local chat-template rendering and tokenization; no inference", measurements };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    const value = index >= 0 ? args[index + 1] : undefined;
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    return value;
  };
  if (!args.includes("--requests") || !args.includes("--tokenizer")) {
    throw new Error("Usage: measure-chat-tokens.ts --requests CAPTURE.json --tokenizer http://127.0.0.1:PORT [--out REPORT.json]");
  }
  const raw = JSON.parse(readFileSync(resolve(option("--requests")), "utf8"));
  const requests = Array.isArray(raw) ? raw : [raw];
  const report = await measureChatRequests(requests, localTokenizerUrl(option("--tokenizer")));
  const text = JSON.stringify(report, null, 2) + "\n";
  if (args.includes("--out")) writeFileSync(resolve(option("--out")), text, { mode: 0o600 });
  process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}

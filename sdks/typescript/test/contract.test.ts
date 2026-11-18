import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";

interface Exchange {
  request: { method: string; body?: unknown; query?: Record<string, string> };
  response: { status?: number; body?: unknown; rawBody?: string; contentType?: string; headers?: Record<string, string>; drop?: boolean };
  repeat?: boolean;
}
interface Case {
  name: string;
  call: { method: "send" | "thread" | "wait" | "ask"; message?: string; thread?: string; options: Record<string, number | string> };
  exchanges: Exchange[];
  result?: unknown;
  error?: { type: string; status?: number; thread?: string; retryAfter?: number | null; message?: string; messageContains?: string };
}
const contract = JSON.parse(readFileSync(new URL("../../contract/cases.json", import.meta.url), "utf8")) as { bot: string; key: string; cases: Case[] };

const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => {
  let text = "";
  req.on("data", (chunk) => (text += chunk));
  req.on("end", () => resolve(text));
});

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => {
  if (!server) return resolve();
  server.closeAllConnections();
  server.close(() => resolve());
}));

describe("contract", () => {
  it.each(contract.cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const queue = [...c.exchanges];
    const problems: string[] = [];
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://stub");
      const raw = await readBody(req);
      const next = queue[0];
      if (!next) { problems.push(`unexpected ${req.method} ${req.url}`); res.writeHead(500).end(); return; }
      if (!next.repeat) queue.shift();
      const want = next.request;
      if (req.method !== want.method) problems.push(`method ${req.method} != ${want.method}`);
      if (url.pathname !== `/hooks/api/v1/bots/${contract.bot}/messages`) problems.push(`path ${url.pathname}`);
      if (req.headers.authorization !== `Bearer ${contract.key}`) problems.push("bad authorization");
      if (want.method === "POST") {
        if (!sameJson(JSON.parse(raw), want.body)) problems.push(`body ${raw}`);
      } else if (!sameJson(Object.fromEntries(url.searchParams), want.query ?? {})) problems.push(`query ${url.search}`);
      const r = next.response;
      if (r.drop) { req.socket.destroy(); return; }
      if (r.rawBody !== undefined) res.writeHead(r.status!, { "content-type": r.contentType!, ...r.headers }).end(r.rawBody);
      else res.writeHead(r.status!, { "content-type": "application/json", ...r.headers }).end(JSON.stringify(r.body));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const bot = new sdk.Bot({ baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, botId: contract.bot, key: contract.key, retryDelay: 0 });
    const { method, message, thread, options } = c.call;
    const run = () => {
      if (method === "send") return bot.send(message!, options);
      if (method === "thread") return bot.thread(thread!);
      if (method === "wait") return bot.wait(thread!, options);
      return bot.ask(message!, options);
    };
    if (c.error) {
      const error = await run().then(() => undefined, (e: unknown) => e);
      const Class = (sdk as unknown as Record<string, new (...a: never[]) => Error>)[c.error.type];
      expect(error).toBeInstanceOf(Class);
      const got = error as Record<string, unknown>;
      for (const field of ["status", "thread", "retryAfter", "message"] as const) {
        const want = c.error[field];
        if (want === null) expect(got[field]).toBeUndefined();
        else if (want !== undefined) expect(got[field]).toBe(want);
      }
      if (c.error.messageContains) expect(got.message).toContain(c.error.messageContains);
    } else {
      expect(await run()).toEqual(c.result);
    }
    expect(problems).toEqual([]);
    expect(queue.filter((e) => !e.repeat)).toEqual([]);
  });
});

function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(sort(a)) === JSON.stringify(sort(b));
}
function sort(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sort);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort().map(([k, x]) => [k, sort(x)]));
  return v;
}

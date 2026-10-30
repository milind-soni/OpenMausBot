// End-to-end on the fakes: a scripted bot shows a dashboard folder (index.html, a script and a Parquet file) inline,
// its frame's files load through the token route with no sign-in, another bot can't show that folder, and publishing the
// folder gives the same card its link. One loopback stub stands in for the pages service; no model is called.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { FAKE_DESKTOP_TOKEN, fakePagesService } from "./testing/fake-pages.ts";

const owner = randomBytes(32).toString("base64url");
const realFetch = globalThis.fetch;
let stub: { server: Server; url: string; service: ReturnType<typeof fakePagesService> };
let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
const PARQUET = Buffer.concat([Buffer.from("PAR1"), randomBytes(2_048), Buffer.from("PAR1")]);

async function serveStub() {
  let service!: ReturnType<typeof fakePagesService>;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const answer = await service.fetch(new Request(`${url}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>,
        ...(body.length ? { body } : {}) })).catch(() => new Response("{}", { status: 404 }));
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(Buffer.from(await answer.arrayBuffer()));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no stub port");
  const url = `http://127.0.0.1:${address.port}`;
  service = fakePagesService({ admin: url, upload: url });
  return { server, url, service };
}

beforeAll(async () => {
  stub = await serveStub();
  globalThis.fetch = (input, init = {}) => realFetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "x-openmausbot-desktop-owner": owner } });
  fixture = await launchVerificationServer({ ...process.env, OMB_TEST_DESKTOP_OWNER_TOKEN: owner,
    OMB_TEST_DESKTOP_PAGES_ACCESS: JSON.stringify({ url: `${stub.url}/api/cloud/pages/token`, token: FAKE_DESKTOP_TOKEN }) }, undefined, undefined, undefined, undefined, { scripted: true });
}, 90_000);
afterAll(async () => {
  globalThis.fetch = realFetch;
  stub?.server.close();
  await fixture?.close();
});

it("shows a dashboard folder inline, serves its Parquet to the frame by token only, keeps other bots out, and gives the card its link on publish", async () => {
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: fixture.info.url } }) as Promise<any>;
  const api = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${fixture.info.url}${path}`, { ...init, headers: { "content-type": "application/json" } });
    return { status: response.status, body: await response.json() as any };
  };
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const evidence = (botId: string) => (existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean) : [])
    .map((line) => JSON.parse(line)).filter((entry: any) => entry.botId === botId);
  const turn = async (bot: any, steps: unknown[]) => {
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { steps, reply: "Done." } }));
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Show me the sales dashboard.");
    expect((await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
    return evidence(bot.id).at(-1).evidence.filter((entry: any) => entry.step).map((entry: any) => entry.response.result.content[0].text as string);
  };
  const analyst = (await cli("new-bot", "--name", "Analyst")).bot;
  const dash = join(fixture.info.dataDir, "workspaces", analyst.id, "dash");
  mkdirSync(dash, { recursive: true });
  writeFileSync(join(dash, "index.html"), "<!doctype html><h1>Sales</h1><script src=\"app.js\"></script>");
  writeFileSync(join(dash, "app.js"), "fetch(new URL(\"data.parquet\", document.baseURI));");
  writeFileSync(join(dash, "data.parquet"), PARQUET);

  const [shown] = await turn(analyst, [{ tool: "show_html", arguments: { path: "dash", title: "Sales dashboard" } }]);
  const appId = /^Shown as app ([\w-]+)\./.exec(shown!)?.[1];
  expect(appId, shown).toBeTruthy();
  const doc = await api(`/api/threads/${analyst.activeTaskId}/messages/${appId}/app?origin=${encodeURIComponent(fixture.info.url)}`);
  const base = /<base href="([^"]+)">/.exec(doc.body.srcdoc)?.[1] ?? "";
  expect(base).toMatch(new RegExp(`^${fixture.info.url}/api/page-files/[A-Za-z0-9_-]{43}/$`));
  expect(doc.body.csp).toContain(`connect-src https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com ${base} https://extensions.duckdb.org;`);
  expect(doc.body.srcdoc).toContain("<h1>Sales</h1><script src=\"app.js\"></script>");

  // The frame's own requests: no sign-in, only the token, from an opaque origin.
  const ranged = await realFetch(`${base}data.parquet`, { headers: { range: "bytes=0-3" } });
  expect(ranged.status).toBe(206);
  expect(ranged.headers.get("access-control-allow-origin")).toBe("*");
  expect(Buffer.from(await ranged.arrayBuffer()).toString()).toBe("PAR1");
  const whole = await realFetch(`${base}data.parquet`);
  expect(Buffer.from(await whole.arrayBuffer()).equals(PARQUET)).toBe(true);
  // A dot segment, even percent-encoded, is folded away by the URL itself and lands outside the token's folder.
  expect((await realFetch(`${base}%2e%2e/index.html`)).status).toBe(404);
  expect((await realFetch(`${base}..%2Fapp.js`)).status).toBe(400);
  expect((await realFetch(`${base.replace(/\/api\/page-files\/[^/]+\//, `/api/page-files/${"A".repeat(43)}/`)}data.parquet`)).status).toBe(404);

  const other = (await cli("new-bot", "--name", "Other")).bot;
  writeFileSync(planPath, JSON.stringify({ [other.id]: { steps: [{ tool: "show_html", arguments: { path: dash, title: "Not mine" }, expectError: true }], reply: "No." } }));
  await cli("send", "--bot", other.id, "--task", other.activeTaskId, "--text", "Show me their dashboard.");
  expect((await cli("wait", "--bot", other.id, "--task", other.activeTaskId, "--timeout", "30")).status).toBe("settled");
  expect(evidence(other.id).at(-1).evidence.find((entry: any) => entry.step).response.result.content[0].text).toMatch(/^path: Only files in your working folder/);

  const [published] = await turn(analyst, [{ tool: "publish_page", arguments: { path: "dash", title: "Sales dashboard" } }]);
  const [pageId] = [...stub.service.pages.keys()];
  expect(published).toContain(`Published “Sales dashboard” at https://${pageId}.mausbot.page/`);
  expect(Buffer.from(stub.service.pages.get(pageId!)!.files.get("data.parquet")!, "latin1").byteLength).toBeGreaterThan(0);
  const rows = (await api(`/api/threads/${analyst.activeTaskId}/messages?limit=50`)).body.messages as any[];
  expect(rows.filter((message) => message.kind === "app").map((message) => [message.id, message.publishedPage?.state, message.publishedPage?.url]))
    .toEqual([[appId, "live", `https://${pageId}.mausbot.page/`]]);
  expect(rows.filter((message) => message.publishedPage && message.kind !== "app")).toEqual([]);
}, 120_000);

// End-to-end: a bot on a real server and a real agents proxy publishes a page from its working folder, republishes it
// to the same link, and the person unpublishes it from the card. The desktop's pages access arrives on the private
// parent port; one loopback stub stands in for the Admin's token route and the pages Worker. No external service is reached.
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

it("publishes a bot's page to a link shown inline, keeps the link and the card on a republish, and unpublishes it from the card", async () => {
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: fixture.info.url } }) as Promise<any>;
  const api = async (path: string, init: RequestInit = {}) => (await fetch(`${fixture.info.url}${path}`, { ...init, headers: { "content-type": "application/json" } })).json() as Promise<any>;
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const bot = (await cli("new-bot", "--name", "Publisher")).bot;
  const site = join(fixture.info.dataDir, "workspaces", bot.id, "site");
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, "index.html"), "<!doctype html><h1>Bake sale</h1>");
  const turn = async (steps: Array<{ tool: string; arguments: unknown }>) => {
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { steps, reply: "Done." } }));
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Make me a page for the bake sale and share it.");
    expect((await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const lines = existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean) : [];
    const evidence = lines.map((line) => JSON.parse(line)).filter((entry: any) => entry.botId === bot.id).at(-1).evidence;
    return { tools: evidence[0].result.tools.map((tool: any) => tool.name) as string[],
      results: evidence.filter((entry: any) => entry.step).map((entry: any) => entry.response.result.content[0].text as string) };
  };

  const first = await turn([{ tool: "publish_page", arguments: { path: "site", title: "Bake sale" } }]);
  expect(first.tools).toEqual(expect.arrayContaining(["publish_page", "unpublish_page"]));
  const [pageId] = [...stub.service.pages.keys()];
  const url = `https://${pageId}.mausbot.page/`;
  expect(first.results[0]).toContain(`Published “Bake sale” at ${url}`);
  expect(stub.service.minted).toEqual([{ action: "create", caller: "desktop" }]);

  writeFileSync(join(site, "index.html"), "<!doctype html><h1>Bake sale, Saturday</h1>");
  const second = await turn([{ tool: "publish_page", arguments: { path: "site", title: "Bake sale" } }]);
  expect(second.results[0]).toContain(`Updated “Bake sale” at the same link: ${url}`);
  expect(stub.service.pages.get(pageId!)!.files.get("index.html")).toBe("<!doctype html><h1>Bake sale, Saturday</h1>");

  // The page shows in the chat as one inline card with its link; publishing the same folder again updates that card.
  const thread = await api(`/api/threads/${bot.activeTaskId}/messages?limit=50`);
  const cards = thread.messages.filter((message: any) => message.publishedPage);
  expect(cards.map((message: any) => [message.kind, message.text, message.publishedPage.state, message.publishedPage.url, message.app?.rev])).toEqual([
    ["app", "[App] Bake sale\nBake sale, Saturday", "live", url, 1]]);
  const doc = await api(`/api/threads/${bot.activeTaskId}/messages/${cards[0].id}/app`);
  expect(doc.srcdoc).toContain("<h1>Bake sale, Saturday</h1>");

  expect(await api(`/api/published-pages/${pageId}/unpublish`, { method: "POST", body: "{}" })).toMatchObject({ ok: true, card: { state: "unpublished" } });
  expect(stub.service.pages.size).toBe(0);
  const after = await api(`/api/threads/${bot.activeTaskId}/messages?limit=50`);
  expect(after.messages.filter((message: any) => message.publishedPage).map((message: any) => [message.kind, message.text, message.publishedPage.state]))
    .toEqual([["app", "[App] Bake sale\nBake sale, Saturday", "unpublished"]]);
}, 120_000);

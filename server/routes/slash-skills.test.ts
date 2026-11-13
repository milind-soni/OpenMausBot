import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Store } from "../store.ts";
import type { SkillListing } from "../skills.ts";
import { createBotSkillsRoutes } from "./bot-skills.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))); });
const list = vi.fn(() => [
  { name: "weekly-report", description: "Prepare the weekly report.", enabled: true, source: "/private/skills", files: ["secret.txt"], warnings: ["private metadata"] },
  { name: "disabled-skill", description: "Disabled", enabled: false },
] as SkillListing[]);
async function serve() {
  list.mockClear();
  const bot = { id: "b1", threadId: "main", assignedSkills: ["weekly-report"] };
  const store = { bot: (id: string) => id === bot.id ? bot : undefined, taskByThread: (id: string, thread: string) => id === bot.id && ["main", "side"].includes(thread) ? {} : undefined } as unknown as Store;
  const routes = [createBotSkillsRoutes({ store, cfg: {} as AppConfig, listBotSkills: list, readBotSkillFile: () => null, stagedSkillListing: staged => staged })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
describe("the read-only slash skill catalog", () => {
  it("returns only enabled names and descriptions for the selected thread", async () => {
    const url = await serve();
    const response = await fetch(`${url}/api/bots/b1/slash-skills?threadId=side`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ skills: [{ name: "weekly-report", description: "Prepare the weekly report.", enabled: true }] });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ id: "b1" }), "side");
  });
  it("requires an explicit conversation instead of falling back to a private selected thread", async () => {
    const url = await serve();
    expect((await fetch(`${url}/api/bots/b1/slash-skills`)).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });
  it("rejects a missing bot or another bot's thread without listing anything", async () => {
    const url = await serve();
    expect((await fetch(`${url}/api/bots/missing/slash-skills`)).status).toBe(404);
    expect((await fetch(`${url}/api/bots/b1/slash-skills?threadId=someone-elses-thread`)).status).toBe(404);
    expect(list).not.toHaveBeenCalled();
  });
});

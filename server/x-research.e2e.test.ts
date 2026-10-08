// End-to-end coverage for X research: the per-bot switch a real server keeps,
// and, with a loopback treg stub (OMB_TREG_URL), the x_* tools a real agents
// proxy advertises and calls. No external service is reached.
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

interface Seen { path: string; token: string | undefined; body: unknown }

/** A loopback treg answering anyapi's search with one row. */
async function serveTreg(seen: Seen[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk; });
    req.on("end", () => {
      seen.push({ path: req.url ?? "", token: req.headers["x-treg-token"] as string | undefined, body: raw ? JSON.parse(raw) : undefined });
      if (req.url !== "/call/anyapi.x.search.posts") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: { data: { items: [
        { id: "2107987482155561188", authorUsername: "maus", authorName: "Maus", createdUtc: 1791418354, text: "MausBot searched X", likeCount: 4, viewCount: 120 },
      ], nextCursor: "" } }, provider: "AnyAPI", costUsd: 0.00075 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no stub port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function withXFixture(test: (f: any) => Promise<void>) {
  const seen: Seen[] = [];
  const treg = await serveTreg(seen);
  const session = await launchVerificationServer({ ...process.env, OMB_TREG_URL: treg.url }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  const planPath = join(session.info.dataDir, "room-plan.json");
  try {
    await test({
      cli,
      api,
      seen,
      savePlan: (plan: Record<string, unknown>) => writeFileSync(planPath, JSON.stringify(plan)),
      turnFor: (botId: string) => {
        const lines = existsSync(planPath + ".evidence.jsonl") ? readFileSync(planPath + ".evidence.jsonl", "utf8").trim().split("\n").filter(Boolean) : [];
        return lines.map((line) => JSON.parse(line)).find((entry: any) => entry.botId === botId);
      },
    });
  } finally {
    treg.server.close();
    await session.close();
  }
}

it("keeps X research off for a new bot and accepts only a boolean switch", async () => withXFixture(async (f) => {
  const bot = (await f.cli("new-bot", "--name", "X bot")).bot;
  expect(bot.xResearch).toBeUndefined();
  const patched = await f.api("/api/bots/" + bot.id, { xResearch: true }, "PATCH");
  expect(patched.bot.xResearch).toBe(true);
  await expect(f.api("/api/bots/" + bot.id, { xResearch: "yes" }, "PATCH")).rejects.toThrow(/xResearch must be true or false/);
}), 60_000);

it("shows the X tools only to a switched-on bot, and serves its search through treg with the saved token", async () => withXFixture(async (f) => {
  await f.api("/api/config", { treg: { token: "e2e-token" } }, "PUT");
  const off = (await f.cli("new-bot", "--name", "X off")).bot;
  const on = (await f.cli("new-bot", "--name", "X on")).bot;
  await f.api("/api/bots/" + on.id, { xResearch: true }, "PATCH");
  f.savePlan({
    [off.id]: { steps: [], reply: "No X here." },
    [on.id]: { steps: [{ tool: "x_search", arguments: { query: "mausbot" } }], reply: "Found one post." },
  });
  for (const bot of [off, on]) {
    await f.cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "What is X saying about MausBot?");
    expect((await f.cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
  }

  const listedOff = f.turnFor(off.id).evidence[0].result.tools.map((tool: any) => tool.name);
  expect(listedOff).not.toContain("x_search");

  const turn = f.turnFor(on.id);
  expect(turn.evidence[0].result.tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining(["x_search", "x_user_posts", "x_post", "x_profile"]));
  const step = turn.evidence.find((entry: any) => entry.step);
  expect(step.response.result.isError, step.response.result.content?.[0]?.text).toBeFalsy();
  const answer = JSON.parse(step.response.result.content[0].text);
  expect(answer.posts).toEqual([expect.objectContaining({ id: "2107987482155561188", author: "@maus", text: "MausBot searched X", likes: 4, views: 120 })]);
  expect(answer.newestId).toBe("2107987482155561188");

  expect(f.seen).toEqual([{ path: "/call/anyapi.x.search.posts", token: "e2e-token", body: { query: "mausbot", queryType: "Latest", limit: 20 } }]);
}), 90_000);

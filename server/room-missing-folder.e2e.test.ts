// MOCA-383: a Codex bot handed work in a room runs in the room's folder, never its own, and a room keeps that folder for good.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("a room whose folder was deleted names that folder when work handed there fails, not the bot's settings", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true }, ["codex"]);
  const { url, dataDir } = session.info;
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.ok, `${method} ${path} ${response.status}: ${JSON.stringify(value)}`).toBe(true);
    return value;
  };
  try {
    const lead = (await cli("new-bot", "--name", "Sam")).bot;
    const cliff = (await cli("new-bot", "--name", "Cliff")).bot;
    const codexModel = (await cli("models")).instances.find((item: any) => item.instanceId === "codex").models.options[0].id;
    await cli("set-model", "--bot", cliff.id, "--instance", "codex", "--model", codexModel);
    // Cliff's own folder is fine: a direct message would run there.
    const own = join(dataDir, "cliff-own");
    mkdirSync(own);
    await api("PATCH", `/api/bots/${cliff.id}`, { cwd: own });

    const site = join(dataDir, "site");
    mkdirSync(site);
    const { group: room } = await api("POST", "/api/groups", {
      name: "Launch room", memberIds: [lead.id, cliff.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    });
    await api("PATCH", `/api/groups/${room.id}`, { cwd: site });
    rmSync(site, { recursive: true });

    writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({
      [lead.id]: { steps: [{ arguments: { group_id: room.id, bot_ids: [cliff.id], message: "Draft the launch post.", request_key: "launch" } }], reply: "Assigned", resumeReply: "Done" },
    }));
    await api("POST", `/api/bots/${lead.id}/messages`, { text: "Get Cliff drafting in the launch room." });

    const failure = async () => ((await api("GET", `/api/threads/${room.threadId}/messages?limit=100`)).messages as any[])
      .find((m) => m.kind === "activity" && m.tool?.ok === false && m.from?.botId === cliff.id)?.tool.name as string | undefined;
    await expect.poll(failure, { timeout: 40_000 }).toBeTruthy();
    const said = await failure();
    expect(said).toContain(`This room's working folder no longer exists: ${site}`);
    expect(said).not.toMatch(/bot's settings|isn't installed|PATH/);
  } finally {
    await session.close();
  }
}, 120_000);

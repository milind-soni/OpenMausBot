// MOCA-393: a bot working in a project hands a teammate a new thread in that same folder, so the project's rules load there.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("starts a teammate's thread in the delegating bot's project folder by default, and hands off without one when there is none, even when asked", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
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
  // A project lives outside OpenMausBot's data; folders inside it are bots' private workspaces.
  const site = mkdtempSync(join(tmpdir(), "omb-site-"));
  const evidence = () => {
    try { return readFileSync(join(dataDir, "room-plan.json.evidence.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
  };
  try {
    const sam = (await cli("new-bot", "--name", "Sam")).bot;
    const pip = (await cli("new-bot", "--name", "Pip")).bot;
    const cliff = (await cli("new-bot", "--name", "Cliff")).bot;
    const own = join(dataDir, "cliff-own");
    mkdirSync(own);
    writeFileSync(join(site, "AGENTS.md"), "# Site rules\n");
    await api("PATCH", `/api/bots/${sam.id}`, { cwd: site });
    await api("PATCH", `/api/bots/${cliff.id}`, { cwd: own });

    const ask = (thread: string, inMyFolder?: boolean) =>
      ({ arguments: { bot_ids: [cliff.id], message: "Draft the launch post.", thread, ...(inMyFolder === undefined ? {} : { in_my_folder: inMyFolder }) } });
    writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({
      [sam.id]: { steps: [ask("standing")], reply: "Assigned", resumeReply: "Done" },
      // Pip has no folder of its own: its conversation runs in a private task folder, so in_my_folder has nothing to share.
      [pip.id]: { steps: [ask("standing", true)], reply: "Handed over" },
      [cliff.id]: { reply: "Drafted", writeFiles: { "cliff-was-here.txt": "yes" } },
    }));

    await api("POST", `/api/bots/${sam.id}/messages`, { text: "Get Cliff drafting in this project." });
    const ranIn = () => [site, own].filter((folder) => existsSync(join(folder, "cliff-was-here.txt")));
    await expect.poll(() => ranIn().length, { timeout: 40_000 }).toBe(1);
    expect(ranIn(), "the folder Cliff's turn ran in").toEqual([site]);
    const cliffTasks = (await api("GET", "/api/bots")).bots.find((b: any) => b.id === cliff.id).tasks as any[];
    expect(cliffTasks.find((t: any) => t.openedBy?.botId === sam.id)?.cwd).toBe(site);

    await api("POST", `/api/bots/${pip.id}/messages`, { text: "Get Cliff drafting." });
    await expect.poll(() => evidence().some((turn) => turn.botId === pip.id && Array.isArray(turn.evidence)), { timeout: 40_000 }).toBe(true);
    const replies = evidence().find((turn) => turn.botId === pip.id).evidence
      .filter((entry: any) => entry?.step).map((entry: any) => String(entry.response.result?.content?.[0]?.text ?? JSON.stringify(entry.response)));
    expect(replies).toHaveLength(1);
    expect(replies[0]).not.toMatch(/in_my_folder|no project folder/);
    await expect.poll(() => existsSync(join(own, "cliff-was-here.txt")), { timeout: 40_000 }).toBe(true);
  } finally {
    await session.close();
    rmSync(site, { recursive: true, force: true });
  }
}, 120_000);

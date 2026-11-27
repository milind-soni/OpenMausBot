import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireBot, WireGroup } from "../shared/wire.ts";

// The scripted fake engine reports this prompt size on every turn, so each room turn measures the bot as nearly full.
const CONTEXT_TOKENS = 990_000;

it("shows a bot's room context, compacts on request, and compacts before a turn above the threshold", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_CONTEXT_TOKENS: String(CONTEXT_TOKENS) },
    undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]);
  const post = (path: string, body: unknown = {}) =>
    fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const bot = (await control("new-bot", "--name", "Editor") as { bot: Pick<WireBot, "id" | "name"> }).bot;
    const other = (await control("new-bot", "--name", "Outsider") as { bot: Pick<WireBot, "id"> }).bot;
    writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({ [bot.id]: { reply: "Edited." } }));
    const room = (await control("new-channel", "--name", "Edit bay", "--members", bot.id) as { channel: Pick<WireGroup, "id"> & { activeTaskId: string } }).channel;
    const read = async () => ((await (await fetch(url + "/api/bots?messages=0")).json()) as { groups: WireGroup[] })
      .groups.find(group => group.id === room.id)!;
    const chips = async () => ((await (await fetch(`${url}/api/threads/${room.activeTaskId}/messages`)).json()) as { messages: Array<{ kind: string; tool?: { name: string } }> })
      .messages.filter(message => message.kind === "activity" && /compacted/.test(message.tool?.name ?? "")).map(message => message.tool!.name);
    const send = async (text: string) => {
      await control("send-channel", "--channel", room.id, "--text", `@Editor ${text}`);
      expect(await control("wait", "--channel", room.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    };

    expect((await post(`/api/groups/${room.id}/members/${bot.id}/compact`)).status).toBe(409);
    expect((await post(`/api/groups/${room.id}/members/${other.id}/compact`)).status).toBe(404);

    const turns = () => readFileSync(join(dataDir, "room-plan.json.evidence.jsonl"), "utf8").trim().split("\n")
      .map(line => JSON.parse(line) as { botId: string; pid: number }).filter(turn => turn.botId === bot.id);
    const config = async (context: Record<string, unknown>) => expect((await fetch(url + "/api/config", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ context }) })).ok).toBe(true);

    await config({ autoCompact: false });
    await send("Cut the intro.");
    await expect.poll(async () => (await read()).memberContext?.[bot.id]?.tokens, { timeout: 5_000 }).toBe(CONTEXT_TOKENS);
    const measured = (await read()).memberContext![bot.id]!;
    expect(measured.tokens / measured.window).toBeGreaterThanOrEqual(0.9);
    await send("Trim the middle.");
    expect(await chips()).toEqual([]);
    expect(turns()[1]!.pid).toBe(turns()[0]!.pid);

    const requested = await post(`/api/groups/${room.id}/members/${bot.id}/compact`);
    expect(requested.status).toBe(202);
    expect(((await requested.json()) as { group: WireGroup }).group.memberContext?.[bot.id]?.compactRequested).toBe(true);
    await send("Tighten the outro.");
    expect(await chips()).toEqual([expect.stringMatching(/^compacted Editor's context \(\d+% full\)/)]);
    expect(turns()[2]!.pid).not.toBe(turns()[1]!.pid);

    await config({ autoCompact: true });
    await expect.poll(async () => (await read()).memberContext?.[bot.id]?.compactRequested, { timeout: 5_000 }).toBeUndefined();
    await send("Export it.");
    expect((await chips()).at(-1)).toMatch(/^Editor's context was \d+% full: compacted/);
    expect(turns()[3]!.pid).not.toBe(turns()[2]!.pid);
  } finally { await fixture.close(); }
}, 90_000);

it("drops a member's reading once another member's turn replaces its warm process", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_CONTEXT_TOKENS: String(CONTEXT_TOKENS) },
    undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]);
  try {
    const first = (await control("new-bot", "--name", "Editor") as { bot: Pick<WireBot, "id"> }).bot;
    const second = (await control("new-bot", "--name", "Cutter") as { bot: Pick<WireBot, "id"> }).bot;
    writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({ [first.id]: { reply: "Edited." }, [second.id]: { reply: "Cut." } }));
    const room = (await control("new-channel", "--name", "Edit bay", "--members", `${first.id},${second.id}`) as { channel: Pick<WireGroup, "id"> }).channel;
    const read = async () => ((await (await fetch(url + "/api/bots?messages=0")).json()) as { groups: WireGroup[] })
      .groups.find(group => group.id === room.id)!;
    const send = async (text: string) => {
      await control("send-channel", "--channel", room.id, "--text", text);
      expect(await control("wait", "--channel", room.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    };
    const turns = () => readFileSync(join(dataDir, "room-plan.json.evidence.jsonl"), "utf8").trim().split("\n")
      .map(line => JSON.parse(line) as { botId: string; pid: number });
    await fetch(url + "/api/config", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ context: { autoCompact: false } }) });

    await send("@Editor Cut the intro.");
    await expect.poll(async () => (await read()).memberContext?.[first.id]?.tokens, { timeout: 5_000 }).toBe(CONTEXT_TOKENS);
    // Cutter shares the room's thread and engine, so the driver closes Editor's warm process.
    await send("@Cutter Trim the middle.");
    await expect.poll(async () => Object.keys((await read()).memberContext ?? {}), { timeout: 5_000 }).toEqual([second.id]);
    await send("@Editor Tighten the outro.");
    const editorTurns = turns().filter(turn => turn.botId === first.id);
    expect(editorTurns[1]!.pid).not.toBe(editorTurns[0]!.pid);
    await expect.poll(async () => Object.keys((await read()).memberContext ?? {}), { timeout: 5_000 }).toEqual([first.id]);
  } finally { await fixture.close(); }
}, 90_000);

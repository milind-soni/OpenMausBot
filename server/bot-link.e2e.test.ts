// Two real servers on this machine: one stands in for the person's computer, the other for a server that is theirs alone
// (as My Cloud is). Only each provider's planning is scripted. Nothing outside this machine is asked.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

type Fixture = Awaited<ReturnType<typeof launchVerificationServer>>;

function place(fixture: Fixture) {
  const { url, dataDir } = fixture.info;
  const planPath = join(dataDir, "room-plan.json");
  const plans: Record<string, { turns: unknown[] }> = {};
  const api = async (method: string, path: string, body?: unknown, options: { status?: number; token?: string } = {}) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url, ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(options.status ?? 200);
    return result;
  };
  return {
    url, dataDir, api,
    cli: (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>,
    plan(botId: string, ...turns: unknown[]) { (plans[botId] ??= { turns: [] }).turns.push(...turns); writeFileSync(planPath, JSON.stringify(plans)); },
    providerTurns: (): any[] => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [],
    messages: async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[],
  };
}

it("a bot on the computer and a bot on the person's own server hand each other work and get the result back", async () => {
  const fixtures = [await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true }),
    await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true })];
  const computer = place(fixtures[0]!), home = place(fixtures[1]!);
  try {
    expect(await computer.api("GET", "/api/bot-link")).toEqual({ on: false });
    expect(existsSync(join(computer.dataDir, "bot-link.json"))).toBe(false);

    const writer = (await computer.cli("new-bot", "--name", "Writer")).bot;
    const atlas = (await home.cli("new-bot", "--name", "Atlas")).bot;

    // Pairing is the owner's: the app does it over the person's own sign-in there. The computer's own page is not one.
    await home.api("POST", "/api/bot-link/pair", { computer: { id: "computer", name: "Sam's Mac" }, name: "My server" }, { status: 403 });
    const pairing = await home.api("POST", "/api/auth/pairing", { label: "The person's app", scopes: ["admin", "client"] });
    const owner = (await home.api("POST", "/api/auth/pair", { code: pairing.code })).token as string;
    const thisComputer = { id: (await computer.api("GET", "/.well-known/openmausbot/environment")).environmentId as string, name: "Sam's Mac" };
    const paired = await home.api("POST", "/api/bot-link/pair", { computer: thisComputer, name: "My server" }, { token: owner });
    await computer.api("PUT", "/api/bot-link", { on: true, origin: home.url, token: paired.token, name: "Sam's Mac", cloud: paired.place });
    await expect.poll(async () => (await computer.api("GET", "/api/bot-link")), { timeout: 15_000 }).toMatchObject({ on: true, role: "dialer", online: true, peer: { name: "My server" } });
    await expect.poll(async () => (await computer.api("GET", "/api/bot-link")).bots, { timeout: 15_000 }).toBeGreaterThan(0);

    // The link's own sign-in opens the link and nothing else of the person's server.
    await home.api("GET", "/api/bots?messages=0", undefined, { token: paired.token, status: 403 });
    await home.api("GET", "/api/auth/session", undefined, { token: paired.token, status: 403 });
    // The standing exchange is held open by design: a backup of the linked server does not wait for it to end.
    // (This fixture's sign-in storage sits inside its data folder, which the backup itself then refuses: that check runs
    // only once the "wait for requests to finish" gate has let the backup through.)
    const backup = await fetch(`${home.url}/api/workspace-backup/export`, { method: "POST", headers: { "content-type": "application/json", origin: home.url, authorization: `Bearer ${owner}` },
      body: JSON.stringify({ password: "correct horse battery staple" }), signal: AbortSignal.timeout(20_000) });
    const backedUp = JSON.stringify(await backup.json());
    expect(backup.status, backedUp).not.toBe(409);
    expect(backedUp).not.toMatch(/Wait for bot turns/);
    await expect.poll(async () => (await computer.api("GET", "/api/bot-link")).online, { timeout: 15_000 }).toBe(true);

    // The computer's bot hands work to the server's bot by name, and is resumed with its result.
    home.plan(atlas.id, { reply: "Atlas counted 42 orders." });
    computer.plan(writer.id,
      { steps: [{ tool: "list_bots", arguments: {} }, { tool: "coordinate_bots", arguments: { bot_ids: ["Atlas"], request_key: "count", message: "Count this week's orders." } }], reply: "Asked Atlas." },
      { reply: "Atlas says 42." });
    await computer.cli("send", "--bot", writer.id, "--task", writer.activeTaskId, "--text", "Ask Atlas for this week's order count.");
    await expect.poll(() => home.providerTurns().find((turn) => turn.botId === atlas.id), { timeout: 30_000 }).toBeTruthy();
    expect((await computer.cli("wait", "--bot", writer.id, "--task", writer.activeTaskId, "--timeout", "30")).status).toBe("settled");
    await expect.poll(async () => (await computer.messages(writer.activeTaskId)).some((message) => message.roomRequest?.phase === "result" && /42 orders/.test(message.tool?.output ?? "")), { timeout: 20_000 }).toBe(true);
    const shown = await computer.messages(writer.activeTaskId);
    expect(shown.find((message) => message.roomRequest?.phase === "result").tool.name).toContain("Atlas (My server)");
    expect(shown.filter((message) => message.kind === "text").at(-1)).toMatchObject({ role: "bot", text: "Atlas says 42." });
    expect(home.providerTurns().filter((turn) => turn.botId === atlas.id)).toHaveLength(1);
    const there = (await home.api("GET", "/api/bots")).bots.find((bot: any) => bot.id === atlas.id);
    const work = there.tasks.find((task: any) => /Writer/.test(task.title ?? ""));
    expect(work, JSON.stringify(there.tasks)).toBeTruthy();
    const worked = await home.messages(work.threadId);
    expect(worked.some((message) => /Count this week's orders\./.test(message.text ?? ""))).toBe(true);
    expect(worked.some((message) => message.text === "Atlas counted 42 orders.")).toBe(true);

    // A file goes with the work into the receiving conversation's own inbox, and one the teammate attaches comes back.
    const desk = join(computer.dataDir, "task-workspaces", writer.id, writer.activeTaskId), bench = join(home.dataDir, "task-workspaces", atlas.id, work.threadId);
    mkdirSync(desk, { recursive: true }); mkdirSync(bench, { recursive: true });
    writeFileSync(join(desk, "orders.csv"), "id,total\n1,20\n2,22\n");
    writeFileSync(join(bench, "totals.txt"), "42 in all\n");
    const under = (root: string, name: string): string[] => existsSync(root) ? readdirSync(root, { recursive: true }).map(String).filter((entry) => entry.endsWith(name) && /(^|[\\/])inbox[\\/]/.test(entry)) : [];
    home.plan(atlas.id, { steps: [{ tool: "attach_file", arguments: { path: join(bench, "totals.txt") } }], reply: "Atlas totalled the export." });
    computer.plan(writer.id,
      { steps: [{ tool: "coordinate_bots", arguments: { bot_ids: ["Atlas"], request_key: "export", message: "Total this export.", files: [join(desk, "orders.csv")] } }], reply: "Sent Atlas the export." },
      { reply: "Atlas totalled it." });
    await computer.cli("send", "--bot", writer.id, "--task", writer.activeTaskId, "--text", "Send Atlas the export to total.");
    await expect.poll(() => under(bench, "orders.csv").length, { timeout: 30_000 }).toBe(1);
    expect(readFileSync(join(bench, under(bench, "orders.csv")[0]!), "utf8")).toBe("id,total\n1,20\n2,22\n");
    await expect.poll(() => under(desk, "totals.txt").length, { timeout: 30_000 }).toBe(1);
    expect(readFileSync(join(desk, under(desk, "totals.txt")[0]!), "utf8")).toBe("42 in all\n");
    expect((await computer.cli("wait", "--bot", writer.id, "--task", writer.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const withFiles = await computer.messages(writer.activeTaskId);
    expect(withFiles.some((message) => message.attachments?.some((file: any) => file.name === "orders.csv"))).toBe(true);
    expect(withFiles.some((message) => message.roomRequest?.phase === "result" && message.attachments?.some((file: any) => file.name === "totals.txt"))).toBe(true);

    // And the other way, over the same link.
    computer.plan(writer.id, { reply: "Writer drafted the summary." });
    home.plan(atlas.id,
      { steps: [{ tool: "coordinate_bots", arguments: { bot_ids: ["Writer"], request_key: "draft", message: "Draft the weekly summary." } }], reply: "Asked Writer." },
      { reply: "Writer drafted it." });
    await home.cli("send", "--bot", atlas.id, "--task", atlas.activeTaskId, "--text", "Have Writer draft the weekly summary.");
    await expect.poll(async () => (await home.messages(atlas.activeTaskId)).some((message) => message.roomRequest?.phase === "result" && /drafted the summary/.test(message.tool?.output ?? "")), { timeout: 40_000 }).toBe(true);
    expect((await home.cli("wait", "--bot", atlas.id, "--task", atlas.activeTaskId, "--timeout", "30")).status).toBe("settled");
    expect((await home.messages(atlas.activeTaskId)).filter((message) => message.kind === "text").at(-1)).toMatchObject({ role: "bot", text: "Writer drafted it." });

    // Off on the computer: the server is told, and neither keeps the link.
    expect(await computer.api("PUT", "/api/bot-link", { on: false })).toEqual({ on: false });
    await expect.poll(() => existsSync(join(home.dataDir, "bot-link.json")), { timeout: 10_000 }).toBe(false);
    await home.api("POST", "/api/bot-link/sync", { ack: 0, frames: [], wait: 0 }, { token: paired.token, status: 401 });
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 180_000);

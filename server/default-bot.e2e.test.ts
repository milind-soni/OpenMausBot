// IndBot on a real server in an isolated fixture: a new install's first bot, never deleted or archived, taken off the
// sidebar by its switch, and still holding a Chief's tools once another bot is the Chief. The fake engine holds its turn
// open so this test can start the agents server that turn was handed and call create_bot the way the engine would.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { childEnv } from "./testing/omb-env.ts";

type McpServer = { command: string; args: string[]; env: Record<string, string> };
type Answer = { id: number; result?: { content?: Array<{ text: string }>; isError?: boolean }; error?: { code: number; message: string } };

async function callTool(server: McpServer, name: string, args: unknown): Promise<Answer> {
  const child = spawn(server.command, server.args, { env: childEnv(server.env), stdio: ["pipe", "pipe", "inherit"] });
  try {
    return await new Promise<Answer>((resolve, reject) => {
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline !== -1) resolve(JSON.parse(buffer.slice(0, newline)) as Answer);
      });
      child.on("exit", (code) => reject(new Error(`the agents server exited (${code}) before answering`)));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })}\n`);
    });
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
  }
}

it("makes IndBot a new install's first bot, never deleted, hidden by its switch, with a Chief's tools after the Chief moves on", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang" });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() as any };
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const bots = async () => (await api("GET", "/api/bots")).body.bots as any[];
  try {
    const [ind] = await bots();
    // The fixture renames its starter; it is still the new install's IndBot.
    expect(ind).toMatchObject({ color: "chrome", chiefOfStaff: true, defaultBot: {} });
    expect(ind.messages.map((message: any) => [message.kind, message.helperIntro])).toEqual([["options", true]]);

    const refused = await api("DELETE", `/api/bots/${ind.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(`${ind.name} can't be deleted or archived. To take it off the sidebar, choose Hide in its menu, or turn off "Show ${ind.name} in the sidebar" in Settings → General.`);
    expect((await api("PATCH", `/api/bots/${ind.id}`, { hidden: true })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${ind.id}`, { sidebarHidden: true })).status).toBe(200);
    expect((await bots()).find((bot) => bot.id === ind.id)?.sidebarHidden).toBe(true);
    expect((await api("PATCH", `/api/bots/${ind.id}`, { sidebarHidden: false })).status).toBe(200);
    expect((await bots()).find((bot) => bot.id === ind.id)?.sidebarHidden).toBe(false);
    // A hidden IndBot comes back when it is renamed or moved to a department, unless the change itself says hidden.
    const hiddenAfter = async (patch: Record<string, unknown>) => {
      expect((await api("PATCH", `/api/bots/${ind.id}`, { sidebarHidden: true })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${ind.id}`, patch)).status).toBe(200);
      return (await bots()).find((bot) => bot.id === ind.id)?.sidebarHidden;
    };
    expect(await hiddenAfter({ color: "blue" })).toBe(true);
    expect(await hiddenAfter({ name: "Nova" })).toBe(false);
    expect(await hiddenAfter({ section: "C Suite" })).toBe(false);
    expect(await hiddenAfter({ section: "C Suite" })).toBe(true);
    expect(await hiddenAfter({ name: "Nova Two", sidebarHidden: true })).toBe(true);
    expect((await api("PATCH", `/api/bots/${ind.id}`, { name: ind.name, section: null, sidebarHidden: false })).status).toBe(200);

    const { bot: clive } = await control(["new-bot", "--name", "Clive"]);
    expect((await api("PATCH", `/api/bots/${clive.id}`, { sidebarHidden: true })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${clive.id}`, { chiefOfStaff: true })).status).toBe(200);
    expect((await bots()).find((bot) => bot.id === ind.id)?.chiefOfStaff).toBeFalsy();

    await control(["send", "--bot", ind.id, "--text", "Stay active."]);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 30_000 }).toBe(true);
    const launched = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { systemPrompt: string; mcpConfig: { mcpServers: Record<string, McpServer> } };
    rmSync(fixture.fixtureDumpPath, { force: true });
    const agents = launched.mcpConfig.mcpServers.agents!;
    expect(agents.env.OMB_CHIEF_OF_STAFF).toBe("1");
    expect(launched.systemPrompt).toContain("You are also this person's IndBot");
    expect(launched.systemPrompt).toContain("but you are not the Chief");
    const created = await callTool(agents, "create_bot", { name: "Scout", role: "Researcher", instructions: "Find what the person asks for." });
    expect(created.error).toBeUndefined();
    expect(created.result?.isError, created.result?.content?.[0]?.text).toBeFalsy();
    const after = await bots();
    expect(after.find((bot) => bot.name === "Scout")?.chiefOfStaff).toBeFalsy();
    expect(after.filter((bot) => bot.chiefOfStaff).map((bot) => bot.id)).toEqual([clive.id]);
    expect(after.filter((bot) => bot.defaultBot).map((bot) => bot.id)).toEqual([ind.id]);
    await control(["interrupt", "--bot", ind.id]);
  } finally {
    await fixture.close();
  }
}, 120_000);

it("lets IndBot read the unread notifications and mark finished work read, not once sign-in members share the workspace, and gives no other bot the tools", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang" });
  const api = async (path: string) => (await (await fetch(`${fixture.info.url}${path}`, { signal: AbortSignal.timeout(10_000) })).json()) as any;
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const launch = async (botId: string) => {
    await control(["send", "--bot", botId, "--text", "Stay active."]);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 30_000 }).toBe(true);
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { mcpConfig: { mcpServers: Record<string, McpServer> } };
    rmSync(fixture.fixtureDumpPath, { force: true });
    return dump.mcpConfig.mcpServers.agents!;
  };
  const text = (answer: Answer) => answer.result?.content?.[0]?.text ?? "";
  try {
    const [ind] = (await api("/api/bots")).bots as any[];
    const agents = await launch(ind.id);
    expect(agents.env.OMB_INDBOT).toBe("1");

    const unread = await callTool(agents, "list_unread_notifications", {});
    expect(unread.result?.isError, text(unread)).toBeFalsy();
    expect(text(unread)).toContain('"notifications":[');
    const marked = await callTool(agents, "mark_notifications_read", { ids: ["no-such-notification"] });
    expect(marked.result?.isError, text(marked)).toBeFalsy();
    expect(text(marked)).toContain("Marked none read.");
    expect(text(marked)).toContain("no-such-notification: not an unread notification");
    expect((await callTool(agents, "mark_notifications_read", { ids: "all" })).result?.isError).toBe(true);

    // Sign-in members make the workspace shared: the app filters the feed per viewer, which the bot cannot be.
    const shared = await fetch(`${fixture.info.url}/api/config`, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ signIn: { admins: ["boss@example.test"], members: ["ada@example.test"] } }), signal: AbortSignal.timeout(10_000) });
    expect(shared.status, await shared.text()).toBe(200);
    const refused = await callTool(agents, "list_unread_notifications", {});
    expect(refused.result?.isError, text(refused)).toBe(true);
    expect(text(refused)).toContain("read in the app");
    expect((await callTool(agents, "mark_notifications_read", { ids: ["no-such-notification"] })).result?.isError).toBe(true);

    const { bot: clive } = await control(["new-bot", "--name", "Clive"]);
    const other = await launch(clive.id);
    expect(other.env.OMB_INDBOT).toBe("0");
    expect((await callTool(other, "list_unread_notifications", {})).result?.isError ?? true).toBe(true);
    expect((await callTool(other, "mark_notifications_read", { ids: ["no-such-notification"] })).result?.isError ?? true).toBe(true);
    await control(["interrupt", "--bot", ind.id]);
    await control(["interrupt", "--bot", clive.id]);
  } finally {
    await fixture.close();
  }
}, 180_000);

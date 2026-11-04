// A bot reloads a command server it changed, on a real server with a warm engine process: the saved key stays, a
// secretRef stays one-use, and the next turn gets a new process. Nothing here reaches the user's data or port 8799.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const FAKE_MCP = fileURLToPath(new URL("./testing/fake-mcp-server.ts", import.meta.url));

it("restart keeps the key and replaces the warm process, and so does turning the server off and on in one turn", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-mcp-restart-"));
  const gate = join(scratch, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const dump = () => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
  /** The key the server itself starts with, behind the tool gate the turn mounts it through. */
  const mailKey = (started: any): string | undefined => {
    const mounted = started.mcpConfig.mcpServers.mail;
    return (mounted.env.OMB_GATE_UPSTREAM ? JSON.parse(mounted.env.OMB_GATE_UPSTREAM) : mounted).env.MAIL_KEY;
  };
  let sends = 0;
  let bot: { id: string; threadId: string };
  /** A turn that stays running until `done`, so its bot's tools answer; the dump is what its engine was started with. */
  const turn = async () => {
    sends += 1;
    const text = `Use your tools, take ${sends}`;
    rmSync(gate, { force: true });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId: `restart-e2e-send-${String(sends).padStart(4, "0")}` })).status).toBe(202);
    await expect.poll(() => { try { return JSON.stringify(dump().prompt).includes(text); } catch { return false; } }, { timeout: 30_000 }).toBe(true);
    const started = dump();
    const internal = (path: string, body: unknown) => api("POST", path, body, started.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN);
    const done = async () => {
      writeFileSync(gate, "");
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((one: any) => one.id === bot.id).busy, { timeout: 20_000 }).toBe(false);
    };
    return { started, internal, done };
  };
  try {
    bot = (await api("POST", "/api/bots", { name: "Iris" })).body.bot;
    const setup = await turn();
    const asked = await setup.internal("/api/internal/request-credential", { fromBotId: bot.id, fromThreadId: bot.threadId, label: "Mail key", reason: "To read the mail.", delivery: "ref" });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const saved = await api("POST", `/api/bots/${bot.id}/secret-cards/${asked.body.messageId}/save`, { threadId: bot.threadId, value: "kept-key-value" });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const again = await setup.internal("/api/internal/request-credential", { fromBotId: bot.id, fromThreadId: bot.threadId, label: "Mail key", reason: "To read the mail.", delivery: "ref" });
    const ref = /secret-ref:[0-9a-f]+/.exec(again.body.text)![0];
    const server = { name: "mail", command: process.execPath, args: ["--experimental-strip-types", "--no-warnings", FAKE_MCP] };
    const added = await setup.internal("/api/internal/mcp-servers", { action: "add", ...server, env: { MAIL_KEY: ref } });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.text).toContain("Test: it started and listed its tools");
    await setup.done();
    // Saving the key answered the card the setup turn asked with, so that turn goes on once more. It runs now, while nothing
    // else is sent: later it would take the thread or the warm process from a turn this test checks.
    await expect.poll(() => { try { return JSON.stringify(dump().prompt).includes("OpenMausBot secret update"); } catch { return false; } }, { timeout: 30_000 }).toBe(true);
    await setup.done();

    const launched = await turn();
    await launched.done();
    expect(mailKey(launched.started)).toBe("kept-key-value");
    const warm = await turn();
    expect(warm.started.pid, "with nothing changed the warm process takes the next turn").toBe(launched.started.pid);
    const restarted = await warm.internal("/api/internal/mcp-servers", { action: "restart", name: "mail" });
    expect(restarted.status, JSON.stringify(restarted.body)).toBe(200);
    expect(restarted.body.text).toContain("Its saved keys stay");
    const refused = await warm.internal("/api/internal/mcp-servers", { action: "add", ...server, name: "mail2", env: { MAIL_KEY: ref } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("was already used");
    await warm.done();

    const fresh = await turn();
    expect(fresh.started.pid, "a restart starts a new process").not.toBe(warm.started.pid);
    expect(mailKey(fresh.started)).toBe("kept-key-value");
    expect((await fresh.internal("/api/internal/mcp-servers", { action: "disable", name: "mail" })).status).toBe(200);
    expect((await fresh.internal("/api/internal/mcp-servers", { action: "enable", name: "mail" })).status).toBe(200);
    await fresh.done();

    const cycled = await turn();
    await cycled.done();
    expect(cycled.started.pid, "off and on in one turn starts a new process too").not.toBe(fresh.started.pid);
    expect(mailKey(cycled.started)).toBe("kept-key-value");
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).mcpServers.mail.env).toEqual({ MAIL_KEY: "kept-key-value" });
  } finally {
    writeFileSync(gate, "");
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, hostTimeout(120_000));

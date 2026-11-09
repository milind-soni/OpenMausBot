import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("appoints one operator through an owner session and changes only an allowed setting through its live turn", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang" });
  const { url } = fixture.info;
  const proxies: ChildProcess[] = [];
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  try {
    const operatorBot = (await cli("new-bot", "--name", "Operator Fixture")).bot;
    const otherBot = (await cli("new-bot", "--name", "Other Fixture")).bot;
    const pairing = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
    expect(pairing.status).toBe(200);
    const paired = await api("POST", "/api/auth/pair", { code: pairing.body.code });
    expect(paired.status).toBe(200);
    const owner = paired.body.token as string;
    expect((await api("GET", "/api/chief-operator")).status).toBe(403);
    const initial = await api("GET", "/api/chief-operator", undefined, owner);
    expect(initial.body).toMatchObject({ grant: null, revision: "none" });
    const elected = await api("PUT", "/api/chief-operator", { botId: operatorBot.id, read: ["language"], write: ["language"], expectedRevision: "none" }, owner);
    expect(elected.status).toBe(200);
    expect((await api("PUT", "/api/chief-operator", { botId: otherBot.id, read: ["language"], write: [], expectedRevision: "none" }, owner)).status).toBe(409);

    const mount = async (bot: { id: string }, sender = owner) => {
      rmSync(fixture.fixtureDumpPath, { force: true });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Read the language setting." }, sender)).status).toBe(202);
      await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
      const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as any;
      return dump.mcpConfig.mcpServers.agents as { command: string; args: string[]; env: Record<string, string> };
    };
    const connect = (mounted: Awaited<ReturnType<typeof mount>>) => {
      const proxy = spawn(mounted.command, mounted.args, { cwd: process.cwd(), env: { ...mounted.env, HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir }, stdio: ["pipe", "pipe", "pipe"] });
      proxies.push(proxy);
      const pending = new Map<number, (value: any) => void>();
      let nextId = 0;
      createInterface({ input: proxy.stdout! }).on("line", line => {
        const response = JSON.parse(line) as { id: number; result: unknown };
        pending.get(response.id)?.(response.result);
      });
      return (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} did not answer`)); }, 10_000);
        pending.set(id, value => { clearTimeout(timer); pending.delete(id); resolve(value); });
        proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    };
    const otherMount = await mount(otherBot);
    expect(otherMount.env.OMB_CHIEF_OPERATOR).toBe("0");
    expect((await connect(otherMount)("tools/list")).tools.map((tool: { name: string }) => tool.name)).not.toContain("operator_settings");
    await cli("interrupt", "--bot", otherBot.id);

    const selected = await mount(operatorBot);
    expect(selected.env).toMatchObject({ OMB_CHIEF_OF_STAFF: "0", OMB_CHIEF_OPERATOR: "1" });
    const rpc = connect(selected);
    expect((await rpc("tools/list")).tools.map((tool: { name: string }) => tool.name)).toContain("operator_settings");
    const call = async (arguments_: Record<string, unknown>) => {
      const result = await rpc("tools/call", { name: "operator_settings", arguments: arguments_ });
      return { error: result.isError === true, body: JSON.parse(result.content[0].text) as any };
    };
    const reading = await call({ action: "read" });
    expect(reading.error).toBe(false);
    expect(reading.body.settings).toEqual([{ setting: "language", value: expect.any(String), revision: expect.any(String) }]);
    const denied = await rpc("tools/call", { name: "operator_settings", arguments: { action: "preview", setting: "computerName", value: "Forbidden" } });
    expect(denied.isError).toBe(true);
    const preview = await call({ action: "preview", setting: "language", value: "fr" });
    expect(preview.error).toBe(false);
    expect(preview.body).toMatchObject({ setting: "language", before: reading.body.settings[0].value, after: "fr", target: "platform" });
    const applied = await call({ action: "apply", preview_id: preview.body.previewId, expected_revision: preview.body.revision });
    expect(applied.error).toBe(false);
    expect(applied.body).toMatchObject({ state: "applied", setting: "language", after: "fr" });
    expect((await api("GET", "/api/config", undefined, owner)).body.language).toBe("fr");
    expect((await api("GET", "/api/chief-operator", undefined, owner)).body.audit.at(-1)).toMatchObject({ id: applied.body.receiptId, state: "applied", botId: operatorBot.id, setting: "language" });
    await cli("interrupt", "--bot", operatorBot.id);
    const clientPairing = await api("POST", "/api/auth/pairing", { scopes: ["client"] });
    const client = await api("POST", "/api/auth/pair", { code: clientPairing.body.code });
    expect(client.status).toBe(200);
    const clientMount = await mount(operatorBot, client.body.token);
    const clientRpc = connect(clientMount);
    expect((await clientRpc("tools/list")).tools.map((tool: { name: string }) => tool.name)).toContain("operator_settings");
    expect((await clientRpc("tools/call", { name: "operator_settings", arguments: { action: "read" } })).isError).toBe(true);
    await cli("interrupt", "--bot", operatorBot.id);
    const revoked = await api("DELETE", "/api/chief-operator", { expectedRevision: elected.body.revision }, owner);
    expect(revoked.body).toMatchObject({ revoked: true, revision: "none" });
    const after = await rpc("tools/call", { name: "operator_settings", arguments: { action: "read" } });
    expect(after.isError).toBe(true);
    expect((await api("GET", "/api/config", undefined, owner)).body.language).toBe("fr");
  } finally {
    for (const proxy of proxies) await waitForExit(proxy, { signal: "SIGTERM" });
    await fixture.close();
  }
});

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("gives a Grok turn OpenMausBot's own tools by URL, no proxy process each, every one listed and callable", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["grok"]);
  const { url, dataDir, logPath } = fixture.info;
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(200);
    return result;
  };
  const cli = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const dump = join(dataDir, "grok-launch.json");
  const calls = join(dataDir, "grok-calls.json");
  const engine = (mode: string) => {
    const wrapper = join(dataDir, `grok-${mode}.mjs`);
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      `process.env.FAKE_ACP_MODE = ${JSON.stringify(mode)};`,
      'process.env.FAKE_ACP_MCP_TRANSPORTS = "http";',
      `process.env.FAKE_ACP_DUMP = ${JSON.stringify(dump)};`,
      `process.env.FAKE_ACP_MCP_CALLS_FILE = ${JSON.stringify(calls)};`,
      `await import(${JSON.stringify(new URL("./testing/fake-acp-cli.ts", import.meta.url).href)});`,
    ].join("\n"), { mode: 0o700 });
    return api("PATCH", "/api/instances/grok", { cli: wrapper });
  };
  try {
    expect((await cli("doctor")).ok).toBe(true);
    await engine("mcp-tools");
    const bot = (await cli("new-bot", "--name", "Grok tools")).bot;
    const threadId = bot.activeTaskId ?? bot.threadId;
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "grok", model: "fake-model" } });
    const turn = async (text: string) => {
      await cli("send", "--bot", bot.id, "--task", threadId, "--text", text);
      expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "40")).status).toBe("settled");
      const messages = (await cli("messages", "--bot", bot.id, "--task", threadId)).messages as Array<{ role: string; text?: string }>;
      return messages.filter((message) => message.role === "bot" && !message.text?.startsWith("[digest]")).at(-1)?.text ?? "";
    };

    const listed = await turn("List your tools.");
    const sent = JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8")) as Array<{ name: string; type?: string; url?: string; command?: string }>;
    evidence.push({ sent: sent.map(({ name, type, url, command }) => ({ name, type, url, command })) });
    const own = sent.filter((server) => server.type === "http");
    // Every server this fixture's turn has is OpenMausBot's own, and none is a process.
    expect(own.map((server) => server.name)).toEqual(expect.arrayContaining(["agents", "data"]));
    expect(sent.filter((server) => server.command !== undefined)).toEqual([]);
    for (const server of own) expect(server.url).toBe(`${url}/api/internal/mcp-http/${server.name}`);
    const lists = Object.fromEntries(listed.trim().split("\n").map((line) => line.split(": ")).map(([name, tools]) => [name, tools!.split(",")]));
    expect(Object.keys(lists).sort()).toEqual(own.map((server) => server.name).sort());
    expect(lists.agents).toEqual(expect.arrayContaining(["list_bots"]));
    expect(lists.data).toEqual(expect.arrayContaining(["data_sql"]));

    await engine("mcp-calls");
    writeFileSync(calls, JSON.stringify([
      { server: "agents", name: "list_bots", arguments: {} },
      { server: "data", name: "data_sql", arguments: { sql: "SELECT 41 + 1 AS answer", limit: 1 } },
    ]));
    const called = await turn("Call them.");
    expect(called).toContain("list_bots: ");
    expect(called).toMatch(/data_sql: .*42/s);
    expect(JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8")).every((server: { type?: string }) => server.type === "http")).toBe(true);
    evidence.push({ called });
  } finally {
    const evidencePath = `${logPath}.grok-own-mcp.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath, evidencePath }));
    await fixture.close();
  }
}, 120_000);

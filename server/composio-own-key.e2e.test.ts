// A saved project key against a loopback Composio: the fake engine calls the one granted tool through the session MCP,
// a tool that was not granted is refused, and nothing leaves 127.0.0.1.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { startFakeComposioProject } from "./testing/fake-composio-project.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const KEY = "ak_fixture_own_key_e2e";
const GRANTED = "GITHUB_GET_THE_AUTHENTICATED_USER";
const REFUSED = "GITHUB_CREATE_AN_ISSUE";
const REFUSAL = "is not granted to this bot. This call was not performed. Ask the person to grant it in Edu Bot if they want it run.";

const call = (slug: string) => [{
  name: "COMPOSIO_MULTI_EXECUTE_TOOL",
  server: "composio",
  input: { tools: [{ tool_slug: slug, arguments: {} }] },
}];

it("saves a project key, grants one tool, runs it through the session MCP, and refuses a tool that was not granted", async () => {
  const project = await startFakeComposioProject(KEY);
  const scratch = mkdtempSync(join(tmpdir(), "omb-own-key-"));
  const callsFile = join(scratch, "tool-calls.json");
  const fetchLog = join(scratch, "fetch.log");
  writeFileSync(callsFile, JSON.stringify(call(GRANTED)));
  const bodies: string[] = [];
  const fixture = await launchVerificationServer({
    ...process.env,
    OMB_COMPOSIO_API: project.api,
    OMB_TEST_FETCH_LOG: fetchLog,
    FAKE_CLAUDE_TOOL_CALLS_FILE: callsFile,
  });
  const origin = fixture.info.url;
  const hidden = (text: string) => text.split(KEY).join("[key]");
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(origin + path, {
      method,
      headers: { "content-type": "application/json", origin },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    bodies.push(text);
    expect(response.status, `${method} ${path}: ${hidden(text).slice(0, 400)}`).toBe(expected);
    expect(text, `${method} ${path}`).not.toContain(KEY);
    return JSON.parse(text);
  };
  try {
    const saved = await api("PUT", "/api/config", { composio: { apiKey: KEY } });
    expect(saved.composio).toMatchObject({ configured: true, mode: "self-hosted", last4: KEY.slice(-4) });
    const again = await api("GET", "/api/config");
    expect(again.composio).toMatchObject({ configured: true, mode: "self-hosted", last4: KEY.slice(-4) });

    const catalog = await api("GET", "/api/connectors/catalog");
    expect(catalog.source).toBe("api");
    expect(catalog.cards.map((card: { slug: string }) => card.slug)).toEqual(expect.arrayContaining(["github", "slack", "gmail"]));

    const link = await api("POST", "/api/connectors/github/authorize", {});
    expect(link.url).toMatch(/^https:\/\/backend\.composio\.dev\/link\/lk_fake/);
    expect(project.links).toEqual([{ user: expect.stringMatching(/^openmausbot_/), toolkit: "github" }]);
    const user = project.links[0]!.user;
    project.connect(user, "github");
    await expect.poll(async () => (await api("GET", "/api/connectors?services=github")).services.github.connected, { timeout: hostTimeout(20_000) }).toBe(true);

    const bot = (await api("POST", "/api/bots", { name: "Git" }, 201)).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { connectorTools: { github: { tools: [GRANTED] } } });

    const quiet = async () => {
      const row = ((await api("GET", "/api/bots")).bots as Array<{ id: string; activity?: string; busy?: boolean }>)
        .find((entry) => entry.id === bot.id);
      return Boolean(row && row.activity !== "working" && !row.busy);
    };
    const thread = async () => (await api("GET", `/api/threads/${bot.threadId}/messages`)) as {
      messages: Array<{ text?: string; tool?: { output?: string } }>;
    };
    const visible = (body: Awaited<ReturnType<typeof thread>>) => body.messages.map((message) => `${message.text ?? ""}\n${message.tool?.output ?? ""}`).join("\n");
    const send = (text: string, sendId: string) => api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId }, 202);
    const settle = async (needle: string) => {
      let text = "";
      await expect.poll(async () => {
        text = visible(await thread());
        return (await quiet()) && text.includes(needle);
      }, { timeout: hostTimeout(90_000), interval: 250 }).toBe(true);
      return text;
    };

    await send("Read the signed-in GitHub user", "own-key-e2e-send-0001");
    const granted = await settle(user);
    expect(granted).toContain("successful");
    expect(granted).toContain("ca_fake");
    expect(project.toolCalls).toEqual([expect.objectContaining({ user, tool: "COMPOSIO_MULTI_EXECUTE_TOOL", slugs: [GRANTED] })]);

    writeFileSync(callsFile, JSON.stringify(call(REFUSED)));
    await send("Open an issue", "own-key-e2e-send-0002");
    const refused = await settle(REFUSAL);
    expect(refused).toContain(REFUSED);
    expect(refused).toContain(REFUSAL);
    expect(project.toolCalls.filter((entry) => entry.slugs.includes(REFUSED))).toEqual([]);
    expect(project.requests.length).toBeGreaterThan(0);
    expect(project.requests.every((request) => request.apiKey === KEY)).toBe(true);

    const fetched = readFileSync(fetchLog, "utf8").split("\n").filter(Boolean);
    expect(fetched.length).toBeGreaterThan(0);
    for (const url of fetched) {
      expect(new URL(url).hostname, url).toBe("127.0.0.1");
    }
    expect(fetched.some((url) => url.startsWith(project.origin))).toBe(true);
    expect(fetched.join("\n")).not.toContain("composio.dev");
    expect(fetched.join("\n")).not.toContain(link.url);

    const dump = readFileSync(fixture.fixtureDumpPath, "utf8");
    const log = readFileSync(fixture.info.logPath, "utf8");
    const stored = JSON.stringify(await thread());
    for (const surface of [granted, refused, stored, dump, log, ...bodies]) expect(surface).not.toContain(KEY);
  } finally {
    await fixture.close();
    await project.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, hostTimeout(180_000));

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

// OMB_CLOUDFLARED_PATH names a real cloudflared, and the check then goes through Cloudflare. Without it a stand-in names
// the link's own loopback port as its address, and the check calls that port: everything but the Cloudflare hop is real.
const REAL = process.env.OMB_CLOUDFLARED_PATH?.trim();
const STAND_IN = fileURLToPath(new URL("./testing/fake-cloudflared.mjs", import.meta.url));
const REPLY = "Booked the dentist for Friday at 10:00. The confirmation is in your email.";
const TASK = "Book the dentist for Friday morning";

/** A resolver asked for a quick tunnel's name before Cloudflare publishes it keeps the not-found answer for minutes (macOS
 * does), so this computer's own is asked only once 1.1.1.1 knows the name. */
async function published(host: string) {
  const resolver = new Resolver();
  resolver.setServers(["1.1.1.1"]);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await resolver.resolve4(host).then((found) => found.length > 0, () => false)) return;
    await new Promise((later) => setTimeout(later, 2_000));
  }
}

type Answer = { result?: { content: Array<{ text: string }>; isError?: true; tools?: Array<{ name: string }> }; error?: { message: string } };

// The stand-in is a script with a shebang, which Windows cannot run as a program.
describe.skipIf(process.platform === "win32" && !REAL)("a task Grok Bot hands MausBot over the connector", () => {
  let fixture: VerificationServer;
  let link = "";
  let id = 0;
  // As the desktop app's own window: the owner capability on every call to its server, never on one to the link.
  const owner = randomBytes(32).toString("base64url");
  const realFetch = globalThis.fetch;
  const app = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const address = (url: string) => (REAL ? url : url.replace(/^https:\/\/fixture-(\d+)\.trycloudflare\.com/, "http://127.0.0.1:$1"));
  /** One MCP request as Grok Bot sends it. A new quick tunnel's name can take a few seconds to resolve, so the first
   * requests are tried again until it answers. */
  const mcp = async (method: string, params?: unknown): Promise<Answer> => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) });
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await realFetch(address(link), { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(40_000) });
        if (response.ok) return await response.json() as Answer;
        if (attempt >= 20) throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        if (attempt >= 20) throw error;
      }
      await new Promise((later) => setTimeout(later, 2_000));
    }
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const answer = await mcp("tools/call", { name, arguments: args });
    return { text: answer.result?.content[0]?.text ?? "", isError: answer.result?.isError === true };
  };

  const launchEnv = {
    ...process.env,
    OMB_TEST_DESKTOP_OWNER_TOKEN: owner,
    OMB_CLOUDFLARED_PATH: REAL || STAND_IN,
    FAKE_CLAUDE_TOOL_CALLS: "[]",
    FAKE_CLAUDE_REPLIES: JSON.stringify([REPLY]),
  };

  beforeAll(async () => {
    globalThis.fetch = (input, init = {}) => realFetch(input, String(input).includes("/mcp/move/") ? init
      : { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "x-openmausbot-desktop-owner": owner } });
    fixture = await launchVerificationServer(launchEnv);
  });
  afterAll(async () => {
    if (fixture) await app("DELETE", "/api/setup-import/grok/connector").catch(() => {});
    await fixture?.close();
    globalThis.fetch = realFetch;
  });

  it("starts the main bot's turn as Grok Bot's information only, and reads the reply back once it is done", { timeout: 240_000 }, async () => {
    const opened = await app("POST", "/api/setup-import/grok/connector", {});
    expect(opened.status).toBe(200);
    link = String(opened.body.connectorUrl);
    expect(link).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/mcp\/move\/[\w-]{43}$/);
    if (REAL) await published(new URL(link).hostname);

    const listed = await mcp("tools/list");
    expect(listed.result?.tools?.map((tool) => tool.name)).toEqual(["move_status", "send_export", "hand_off_task", "task_status"]);
    const status = await call("move_status", {});
    expect(status.text).toContain("until the person turns it off");
    expect(status.text).toContain("Fixture Starter");

    const handed = await call("hand_off_task", { task: TASK, to_bot: "Fixture Starter", context: "Any dentist near home is fine." });
    expect(handed.isError).toBe(false);
    const taskId = /task_id: (task_[\w-]+)/.exec(handed.text)?.[1] ?? "";
    expect(handed.text).toContain(`as "From Grok Bot: ${TASK}"`);

    let read = await call("task_status", { task_id: taskId, wait_seconds: 25 });
    for (let tries = 0; tries < 6 && read.text.includes("is being worked on"); tries += 1) read = await call("task_status", { task_id: taskId, wait_seconds: 25 });
    expect(read.text).toContain(`"From Grok Bot: ${TASK}" is done.`);
    expect(read.text).toContain(`Result:\n${REPLY}`);

    // What the main bot's engine was handed: the task, labelled as an app's information, never as the person.
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { prompt?: unknown };
    const told = typeof dump.prompt === "string" ? dump.prompt : JSON.stringify(dump.prompt);
    expect(told).toContain("[From Grok Bot, an app the person connected · task · information only");
    expect(told).toContain(TASK);
    expect(told).toContain("The person would like Fixture Starter to do this.");

    const shown = await app("GET", "/api/setup-import/grok/connector");
    expect(shown.body).toMatchObject({ connectorUrl: link, handoffs: [expect.objectContaining({ title: `From Grok Bot: ${TASK}`, state: "done" })] });
    const [handoff] = shown.body.handoffs as Array<{ botId: string; threadId: string }>;
    const bots = (await app("GET", "/api/bots")).body.bots as Array<{ id: string; tasks?: Array<{ threadId: string; title: string }> }>;
    expect(bots.find((bot) => bot.id === handoff!.botId)?.tasks).toContainEqual(expect.objectContaining({ threadId: handoff!.threadId, title: `From Grok Bot: ${TASK}` }));

    expect((await call("task_status", { task_id: "task_madeUpAndNeverGivenOut" })).isError).toBe(true);
  });

  it("comes back on by itself with the same key at a new address when the app starts again, and says the link changed", { timeout: 180_000 }, async () => {
    const key = new URL(link).pathname;
    const env = verificationServerEnvironment(launchEnv, fixture.info.dataDir, Number(new URL(fixture.info.url).port));
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const again = spawn(process.execPath, verificationServerArgs(env), { cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: "ignore" });
    try {
      let state: Record<string, unknown> = {};
      for (let tries = 0; tries < 300 && !state.connectorUrl; tries += 1) {
        await new Promise((later) => setTimeout(later, 200));
        state = await app("GET", "/api/setup-import/grok/connector").then((answer) => answer.body, () => ({}));
      }
      expect(state).toMatchObject({ connectorUrl: expect.stringMatching(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/mcp\/move\/[\w-]{43}$/), changed: true });
      expect(new URL(String(state.connectorUrl)).pathname, "the same key").toBe(key);
      expect(state.connectorUrl, "a new address").not.toBe(link);
      link = String(state.connectorUrl);
      if (REAL) await published(new URL(link).hostname);
      expect((await call("move_status", {})).text).toContain("its address changes when MausBot restarts or updates");
      expect((await app("POST", "/api/setup-import/grok/connector", { seen: true })).body.changed).toBeUndefined();
    } finally {
      await app("DELETE", "/api/setup-import/grok/connector").catch(() => {});
      await waitForExit(again, { signal: "SIGTERM" });
    }
  });
});

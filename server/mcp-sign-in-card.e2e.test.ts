import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { startFakePostiz, type FakePostiz } from "./testing/fake-postiz.ts";

/** A real server with the fake Claude engine held mid-turn until the gate opens, a stand-in OAuth provider, and Iris's
 * turn that has added the provider's server and called sign_in. */
async function onSignInCard(run: (f: {
  api: (method: string, path: string, body?: unknown, expected?: number, token?: string) => Promise<any>;
  dump: () => any; provider: FakePostiz; url: string; serverUrl: string; iris: { id: string; threadId: string };
  messages: () => Promise<any[]>; card: () => Promise<any>; endTurn: () => Promise<void>;
}) => Promise<void>) {
  const provider = await startFakePostiz();
  const scratch = mkdtempSync(join(tmpdir(), "omb-mcp-sign-in-"));
  const gate = join(scratch, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result).slice(0, 400)}`).toBe(expected);
    return result;
  };
  const dump = () => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return null; } };
  try {
    const iris = (await api("POST", "/api/bots", { name: "Iris" }, 201)).bot;
    const messages = async () => (await api("GET", `/api/threads/${iris.threadId}/messages`)).messages as any[];
    await api("POST", `/api/bots/${iris.id}/messages`, { threadId: iris.threadId, text: "Connect Postiz", sendId: "mcp-sign-in-e2e-send-0001" }, 202);
    let first: any;
    await expect.poll(() => { first = dump(); return JSON.stringify(first?.prompt ?? "").includes("Connect Postiz"); }, { timeout: 20_000 }).toBe(true);
    const token: string = first.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const serverUrl = `${provider.url}/mcp-oauth-dynamic`;
    const added = await api("POST", "/api/internal/mcp-servers", { action: "add", name: "postiz", type: "http", url: serverUrl }, 201, token);
    expect(added.text).toContain("Test: needs sign-in. Call mcp_server with action sign_in and name postiz, then end your turn.");
    const asked = await api("POST", "/api/internal/mcp-servers", { action: "sign_in", name: "postiz" }, 202, token);
    expect(asked.text).toContain("End this turn and wait");
    let shown: any;
    const card = async () => {
      await expect.poll(async () => { shown = (await messages()).find((message) => message.kind === "connector"); return shown?.connector.source; }, { timeout: 20_000 }).toBe("mcp");
      return shown;
    };
    const endTurn = async () => {
      writeFileSync(gate, "");
      await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === iris.id)?.busy, { timeout: 20_000 }).toBe(false);
    };
    await run({ api, dump, provider, url: fixture.info.url, serverUrl, iris, messages, card, endTurn });
  } finally {
    await fixture.close();
    await provider.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

it("a bot adds an OAuth server and asks the person to sign in; they sign in on the provider's page and the bot carries on by itself with the server's tools", () => onSignInCard(async ({ api, dump, provider, url, serverUrl, iris, messages, card, endTurn }) => {
  await endTurn();
  const shown = await card();
  expect(shown.connector).toMatchObject({ slug: "postiz", label: "Postiz", status: "required" });
  expect(shown.text).toBe("Postiz's MCP server needs a sign-in. Open this conversation in OpenMausBot to sign in.");

  const window = await api("POST", "/api/auth/pairing", { scopes: ["client"] });
  const paired = await (await fetch(`${url}/api/auth/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: window.code }) })).json() as { token: string };
  const cardPath = `/api/bots/${iris.id}/connector-cards/${shown.id}`;
  const member = await fetch(`${url}${cardPath}/authorize`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${paired.token}` }, body: JSON.stringify({ threadId: iris.threadId }),
  });
  expect({ status: member.status, body: await member.json() }).toEqual({ status: 409, body: { error: "Only an admin of this installation can sign in to Postiz." } });
  expect(provider.counts.register).toBe(0);

  const { url: link } = await api("POST", `${cardPath}/authorize`, { threadId: iris.threadId });
  expect((await api("GET", `${cardPath}/status?threadId=${iris.threadId}`))).toEqual({ connected: false, pending: true, status: "authorizing" });
  const page = await fetch(link);
  expect(await page.text()).toBe("Signed in. You can close this tab and return to OpenMausBot.");

  let resumed: any;
  await expect.poll(() => { resumed = dump(); return JSON.stringify(resumed?.prompt ?? "").includes("the person signed in to postiz"); }, { timeout: 20_000 }).toBe(true);
  expect(resumed.mcpConfig.mcpServers.postiz, "the resumed turn has the server, signed in").toMatchObject({ url: serverUrl, headers: { Authorization: `Bearer ${provider.issued[0]}` } });
  await expect.poll(async () => (await messages()).find((message) => message.id === shown.id)?.connector, { timeout: 20_000 })
    .toMatchObject({ status: "connected", resumed: true });
  const transcript = JSON.stringify(await messages());
  expect(transcript).not.toContain(link);
  expect(transcript).not.toContain(new URL(link).searchParams.get("state"));
}), 90_000);

it("Not now tapped while the bot's turn is still running reaches the bot once the turn parks", () => onSignInCard(async ({ api, dump, iris, messages, card, endTurn }) => {
  const shown = await card();
  await api("POST", `/api/bots/${iris.id}/connector-cards/${shown.id}/dismiss`, { threadId: iris.threadId });
  await endTurn();
  let resumed: any;
  await expect.poll(() => { resumed = dump(); return JSON.stringify(resumed?.prompt ?? "").includes("The person didn't sign in. The server stays on but signed out."); }, { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await messages()).find((message) => message.id === shown.id)?.connector, { timeout: 20_000 })
    .toMatchObject({ dismissed: true, resumed: true });
}), 90_000);

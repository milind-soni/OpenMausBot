// A My Cloud bot opened in place, end to end on two real servers (scripts/testing/cloud-send-fixture.ts): this computer's
// server, told the session over its private port as main tells it, forwards the page's reads, sends and live stream to a
// real Cloud home through a stand-in for the Cloud's edge. The page's side speaks only `cloud:` ids; the Cloud's turn
// streams back through this computer's server while it runs. Disposable homes, the fake Claude CLI; no network.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture } from "../../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "../testing/host-timeout.ts";

const codeOf = async (response: Response) => ((await response.json()) as { code?: string }).code;
let fx: CloudSendFixture, edge: Server, edgeBase: string, token: string;

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-place-${randomBytes(8).toString("hex")}` });
  // The Cloud's edge: what Fly's proxy adds in front of a Cloud home, for whatever comes to its public address.
  edge = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string" && !["host", "connection", "content-length"].includes(name)) headers.set(name, value);
      for (const [name, value] of Object.entries(fx.edge)) headers.set(name, value);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      try {
        const upstream = await fetch(`${fx.cloudBase}${req.url}`, { method: req.method, headers, body, redirect: "manual" });
        res.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => !["content-encoding", "content-length", "transfer-encoding"].includes(name))));
        res.flushHeaders();
        if (upstream.body) for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
        res.end();
      } catch { res.destroy(); }
    });
  });
  await new Promise<void>((resolve) => edge.listen(0, "127.0.0.1", resolve));
  edgeBase = `http://127.0.0.1:${(edge.address() as AddressInfo).port}`;
  // Main's session for it: the Admin's one-time code, redeemed at My Cloud (electron/place-chat-main.mjs).
  const { code } = await fx.grant("This computer's window");
  const paired = await fetch(`${edgeBase}/api/auth/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, label: "This computer's window" }) });
  token = ((await paired.json()) as { token: string }).token;
  expect(token).toMatch(/^omb_sess_/);
}, hostTimeout(120_000));

afterAll(async () => {
  edge?.closeAllConnections();
  await new Promise((resolve) => edge ? edge.close(resolve) : resolve(null));
  await fx?.close();
});

const page = (path: string, init: RequestInit = {}) => fetch(`${fx.desktopBase}${path}`, { ...init, headers: { "x-openmausbot-desktop-owner": fx.ownerCapability, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });

it("reads, streams and sends a My Cloud bot's conversation through this computer's server, in the page's ids, with no session in sight", async () => {
  // Before main tells it a session, this computer's server forwards nothing.
  const { body: listed } = await fx.onCloud("GET", "/api/bots?messages=0");
  const bot = (listed.bots as Array<{ id: string; threadId: string; name: string }>)[0]!;
  expect(await codeOf(await page(`/api/bots/cloud:${bot.id}`))).toBe("place_closed");

  fx.tellDesktop({ type: "openmausbot:place-session", place: "cloud", origin: edgeBase, token });
  let opened: Response | null = null;
  for (let tries = 0; tries < 50; tries++) {
    opened = await page(`/api/bots/cloud%3A${bot.id}?messages=80`);
    if (opened.status !== 503) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(opened!.status).toBe(200);
  const text = await opened!.text();
  expect(text).not.toContain(token);
  expect(text).not.toContain(edgeBase);
  const { bot: shown } = JSON.parse(text);
  expect(shown.id).toBe(`cloud:${bot.id}`);
  expect(shown.threadId).toBe(`cloud:${bot.threadId}`);
  expect(shown.name).toBe(bot.name);

  // The live stream, open before the send: the Cloud's turn arrives on it while it runs.
  const stop = new AbortController();
  const stream = await page(`/api/places/cloud/events?bot=${encodeURIComponent(shown.id)}`, { signal: stop.signal });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader(), decoder = new TextDecoder();
  let said = "";
  const frames = () => said.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as { kind: string; threadId?: string; message?: { role?: string; text?: string }; event?: { threadId?: string } });
  const until = async (found: () => boolean) => { while (!found()) { const { value, done } = await reader.read(); if (done) throw new Error(`stream ended:\n${said}`); said += decoder.decode(value, { stream: true }); } };
  await until(() => frames().some((frame) => frame.kind === "hello"));

  const sent = await page(`/api/bots/${encodeURIComponent(shown.id)}/messages`, { method: "POST", body: JSON.stringify({ threadId: shown.threadId, text: "cloud: say hello" }) });
  expect(sent.status, await sent.clone().text()).toBeLessThan(300);
  await until(() => frames().some((frame) => frame.kind === "message" && frame.message?.role === "bot"));
  const ours = frames().filter((frame) => frame.kind === "message");
  expect(ours.every((frame) => frame.threadId === shown.threadId)).toBe(true);
  expect(ours.some((frame) => frame.message?.role === "user" && frame.message.text === "cloud: say hello")).toBe(true);
  expect(frames().filter((frame) => frame.kind === "runtime").every((frame) => frame.event?.threadId === shown.threadId)).toBe(true);
  expect(said).not.toContain(token);

  // What the Cloud keeps is the same conversation, in its own ids.
  const { body: there } = await fx.onCloud("GET", `/api/threads/${bot.threadId}/messages?limit=10`);
  expect((there.messages as Array<{ text?: string }>).some((message) => message.text === "cloud: say hello")).toBe(true);

  // Stopping is forwarded too, in the Cloud's ids.
  expect((await page(`/api/bots/${encodeURIComponent(shown.id)}/interrupt`, { method: "POST", body: JSON.stringify({ threadId: shown.threadId }) })).status).toBeLessThan(500);
  // A new conversation is made there and named here in the page's ids.
  const made = await page(`/api/bots/${encodeURIComponent(shown.id)}/tasks`, { method: "POST", body: "{}" });
  expect(made.status, await made.clone().text()).toBeLessThan(300);
  const { bot: fresh } = (await made.json()) as { bot: { id: string; threadId: string; tasks: Array<{ threadId: string }> } };
  expect(fresh.id).toBe(shown.id);
  expect(fresh.threadId).toMatch(/^cloud:/);
  expect(fresh.threadId).not.toBe(shown.threadId);
  expect(fresh.tasks.every((task) => task.threadId.startsWith("cloud:"))).toBe(true);
  stop.abort();

  // Nobody but the app's window gets anything through, and a bot's settings stay on its own page.
  expect((await fetch(`${fx.desktopBase}/api/bots/cloud:${bot.id}`)).status).toBeGreaterThanOrEqual(400);
  expect(await codeOf(await page(`/api/bots/cloud:${bot.id}/soul`))).toBe("place_unsupported");
}, hostTimeout(120_000));

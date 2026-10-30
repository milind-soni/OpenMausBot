import { mkdtempSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  advertisedWebhookBase,
  listenWebhookIngress,
  MAX_WEBHOOK_BODY_BYTES,
  webhookCredential,
  type WebhookIngress,
} from "./webhook-ingress.ts";
import { WebhookManager } from "./webhooks.ts";
import { WorkspaceBackupMaintenance } from "./workspace-backup-maintenance.ts";

let dir: string;
const rawStatus = (baseUrl: string, path: string, method = "GET") => new Promise<number>((resolve, reject) => {
  const sent = request(baseUrl, { path, method }, (response) => {
    response.resume();
    resolve(response.statusCode ?? 0);
  });
  sent.on("error", reject);
  sent.end();
});
let ingress: WebhookIngress;
let endpointId: string;
let secret: string;
let manager: WebhookManager;
const queued: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "omb-webhook-ingress-"));
  manager = new WebhookManager({
    file: join(dir, "webhooks.json"),
    botState: () => "ready",
    enqueue: (input) => {
      queued.push(input);
      return { id: `run-${queued.length}` };
    },
  });
  const created = manager.create({ name: "Build event", prompt: "Review the build", botId: "maus-1" });
  endpointId = created.webhook.endpointId;
  secret = created.secret;
  ingress = await listenWebhookIngress(manager, { port: 0 });
});

afterAll(async () => {
  await new Promise<void>((resolve) => ingress.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("webhook-only ingress", () => {
  it("does not record or enqueue incoming webhooks during workspace backup", async () => {
    const gate = new WorkspaceBackupMaintenance();
    const guarded = await listenWebhookIngress(manager, { port: 0, claimRequest: () => gate.request() });
    const before = manager.listAttempts();
    const beforeQueued = queued.length;
    try {
      await gate.run(async () => {
        const response = await fetch(`${guarded.baseUrl}/hooks/${endpointId}/${secret}`, { method: "POST", body: "{}" });
        expect(response.status).toBe(503);
        expect(manager.listAttempts()).toEqual(before);
        expect(queued).toHaveLength(beforeQueued);
      }, { idle: () => true, pause: () => {}, resume: () => {}, flush: async () => {} });
    } finally {
      await new Promise<void>((resolve) => guarded.server.close(() => resolve()));
    }
  });
  it("exposes health but nothing from the main OpenMausBot API", async () => {
    const health = await fetch(`${ingress.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ app: "openmausbot-webhooks", ready: true });
    expect((await fetch(`${ingress.baseUrl}/api/bots`)).status).toBe(404);
  });

  it("accepts capability URLs and deduplicates retries", async () => {
    const credential = webhookCredential(ingress.baseUrl, endpointId, secret);
    const send = () => fetch(credential.url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "delivery-1", "x-github-event": "push" },
      body: JSON.stringify({ ref: "main", id: "event-in-body" }),
    });
    const first = await send();
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ accepted: true, duplicate: false, runId: "run-1" });
    const retry = await send();
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ accepted: true, duplicate: true, runId: "run-1" });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.prompt).toContain("Event: push");
  });

  it("also accepts a bearer secret without putting it in the URL", async () => {
    const response = await fetch(`${ingress.baseUrl}/hooks/${endpointId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/x-www-form-urlencoded" },
      body: "ticket=42&priority=high",
    });
    expect(response.status).toBe(202);
    expect(queued.at(-1)?.prompt).toContain('"ticket": "42"');
  });

  it("awaits a room delivery and answers 202 only after the post lands; a failing sink is not 2xx", async () => {
    let finish: () => void = () => {};
    let gate = new Promise<void>((resolve) => (finish = resolve));
    const roomDir = mkdtempSync(join(tmpdir(), "omb-webhook-room-"));
    const roomQueued: unknown[] = [];
    const posts: Array<{ payload: Record<string, unknown> }> = [];
    let sinkFails = true;
    const rooms = new WebhookManager({
      file: join(roomDir, "webhooks.json"),
      botState: () => "ready",
      enqueue: (input) => {
        roomQueued.push(input);
        return { id: `room-run-${roomQueued.length}` };
      },
      roomMember: () => ({ ok: true }),
      roomPost: async (_trigger, payload) => {
        await gate;
        if (sinkFails) throw Object.assign(new Error("the voice engine is asleep"), { status: 503 });
        posts.push({ payload: payload as Record<string, unknown> });
        return { posted: true, attachments: 1, threadId: "room-7-thread" };
      },
    });
    const created = rooms.create({ name: "Room brief", prompt: "", botId: "maus-1", delivery: "post", groupId: "room-7" });
    const receiver = await listenWebhookIngress(rooms, { port: 0 });
    const send = (deliveryId: string) => fetch(`${receiver.baseUrl}/hooks/${created.webhook.endpointId}/${created.secret}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": deliveryId },
      body: JSON.stringify({ text: "Deploy done", voiceNote: "deploy done" }),
    });
    try {
      const failing = send("room-evt-1");
      finish();
      expect((await failing).status).toBe(503);
      expect(posts).toHaveLength(0);
      expect(roomQueued).toHaveLength(0);
      expect(rooms.listAttempts().at(-1)).toMatchObject({ outcome: "rejected", statusCode: 503 });

      sinkFails = false;
      gate = new Promise<void>((resolve) => (finish = resolve));
      const accepted = send("room-evt-2");
      const early = await Promise.race([accepted.then(() => "answered"), new Promise((resolve) => setTimeout(() => resolve("pending"), 50))]);
      expect(early).toBe("pending");
      expect(posts).toHaveLength(0);
      finish();
      const response = await accepted;
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ accepted: true, duplicate: false, threadId: "room-7-thread" });
      expect(posts).toHaveLength(1);
      expect(posts[0]?.payload).toMatchObject({ text: "Deploy done", voiceNote: "deploy done" });
      expect(roomQueued).toHaveLength(0);
      expect(created.webhook.groupId).toBe("room-7");
    } finally {
      await new Promise<void>((resolve) => receiver.server.close(() => resolve()));
      rmSync(roomDir, { recursive: true, force: true });
    }
  });

  it("does not deduplicate separate requests that reuse a generic payload id", async () => {
    const credential = webhookCredential(ingress.baseUrl, endpointId, secret);
    const before = queued.length;
    const send = () => fetch(credential.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "shared-record", task: "Handle this update" }),
    });
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(202);
    expect(queued).toHaveLength(before + 2);
  });

  it("captures a verification event without queueing work", async () => {
    const created = manager.create({ name: "Verify", prompt: "", botId: "maus-1", enabled: false, verificationPending: true });
    const before = queued.length;
    const response = await fetch(webhookCredential(ingress.baseUrl, created.webhook.endpointId, created.secret).url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-event": "support.created" },
      body: JSON.stringify({ task: "Triage ticket 42" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, captured: true });
    expect(queued).toHaveLength(before);
    expect(manager.list().find((webhook) => webhook.id === created.webhook.id)).toMatchObject({ verificationPending: false, enabled: false });
  });

  it("rejects invalid credentials, malformed JSON and oversized bodies", async () => {
    const unauthorized = await fetch(`${ingress.baseUrl}/hooks/${endpointId}/wrong`, { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);

    const malformed = await fetch(`${ingress.baseUrl}/hooks/${endpointId}/${secret}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);

    const oversized = await fetch(`${ingress.baseUrl}/hooks/${endpointId}/${secret}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1),
    });
    expect(oversized.status).toBe(413);
    expect(manager.listAttempts().filter((attempt) => attempt.webhookId === manager.list().find((webhook) => webhook.endpointId === endpointId)?.id && attempt.outcome === "rejected").length).toBeGreaterThanOrEqual(3);
  });
});

describe("malformed requests", () => {
  it("answers a request target that is not a URL with 400 and keeps serving", async () => {
    expect(await rawStatus(ingress.baseUrl, "//[")).toBe(400);
    expect(await rawStatus(ingress.baseUrl, "//[", "POST")).toBe(400);
    expect((await fetch(`${ingress.baseUrl}/health`)).status).toBe(200);
  });

  it("answers 500 when the handler itself fails instead of rejecting into the process", async () => {
    const failing = {
      authorize: () => true,
      receive: async () => { throw Object.assign(new Error("bad payload"), { status: 400 }); },
      recordRejected: () => { throw new Error("disk full"); },
    } as unknown as WebhookManager;
    const receiver = await listenWebhookIngress(failing, { port: 0 });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await fetch(`${receiver.baseUrl}/hooks/wh_failing`, { method: "POST", body: "{}" });
      expect(response.status).toBe(500);
      expect(logged).toHaveBeenCalledWith("webhooks: receiver failed", expect.objectContaining({ message: "disk full" }));
      expect((await fetch(`${receiver.baseUrl}/health`)).status).toBe(200);
    } finally {
      logged.mockRestore();
      await new Promise<void>((resolve) => receiver.server.close(() => resolve()));
    }
  });
});

describe("requests with a wrong secret", () => {
  it("answers a malformed escape in the URL secret with 401, not 500", async () => {
    const response = await fetch(`${ingress.baseUrl}/hooks/${endpointId}/%E0%A4%A`, { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid webhook URL or secret" });
  });

  it("neither evicts real deliveries nor rewrites the file for each request", async () => {
    const floodDir = mkdtempSync(join(tmpdir(), "omb-webhook-flood-"));
    const file = join(floodDir, "webhooks.json");
    const emitted = new Set<string>();
    let runs = 0;
    const flooded = new WebhookManager({
      file,
      botState: () => "ready",
      enqueue: () => ({ id: `flood-run-${++runs}` }),
      emit: (frame) => { if (frame.kind === "webhook.attempt") emitted.add(frame.attempt.id); },
    });
    const created = flooded.create({ name: "CI", prompt: "Review", botId: "maus-1" });
    const receiver = await listenWebhookIngress(flooded, { port: 0 });
    const url = `${receiver.baseUrl}/hooks/${created.webhook.endpointId}`;
    const deliver = (id: string) => fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${created.secret}`, "content-type": "application/json", "idempotency-key": id },
      body: "{}",
    });
    try {
      expect((await deliver("real-1")).status).toBe(202);
      const written = statSync(file);
      for (let i = 0; i < 2_100; i += 1) {
        const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "" });
        expect(response.status).toBe(401);
        await response.arrayBuffer();
      }
      const after = statSync(file);
      expect([after.ino, after.mtimeMs]).toEqual([written.ino, written.mtimeMs]);

      const attempts = flooded.listAttempts();
      expect(attempts.filter((attempt) => attempt.outcome === "accepted").map((attempt) => attempt.deliveryId)).toEqual(["real-1"]);
      const rejected = attempts.filter((attempt) => attempt.outcome === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({ statusCode: 401, reason: "Invalid webhook URL or secret (2100 requests)" });
      expect(emitted.size).toBe(2);

      expect((await deliver("real-2")).status).toBe(202);
      const reloaded = new WebhookManager({ file, botState: () => "ready", enqueue: () => ({ id: "unused" }) });
      expect(reloaded.listAttempts().map((attempt) => [attempt.outcome, attempt.statusCode])).toEqual([
        ["accepted", 202],
        ["rejected", 401],
        ["accepted", 202],
      ]);
    } finally {
      await new Promise<void>((resolve) => receiver.server.close(() => resolve()));
      rmSync(floodDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("advertised base URL", () => {
  it("hands senders the public base instead of the loopback listener", async () => {
    const proxied = await listenWebhookIngress(manager, { port: 0, publicBaseUrl: "https://bots.example.com/" });
    try {
      expect(proxied.baseUrl).toBe("https://bots.example.com");
      expect(proxied.host).toBe("127.0.0.1");
      const credential = webhookCredential(proxied.baseUrl, endpointId, secret);
      expect(credential.endpointUrl).toBe(`https://bots.example.com/hooks/${endpointId}`);
      const health = await fetch(`http://127.0.0.1:${proxied.port}/health`);
      expect(health.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => proxied.server.close(() => resolve()));
    }
  });

  it("refuses a base that is not an absolute http(s) URL, naming the fix", () => {
    for (const bad of ["bots.example.com", "ftp://bots.example.com", "", "/hooks"]) {
      expect(() => advertisedWebhookBase(bad)).toThrow(/absolute http\(s\) URL such as https:\/\//);
    }
    expect(advertisedWebhookBase("http://10.0.0.5:8800///")).toBe("http://10.0.0.5:8800");
  });
});

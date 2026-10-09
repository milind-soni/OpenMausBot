import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
      // More bad requests than the shared history holds (2,000).
      for (let i = 0; i < 2_100; i += 1) {
        const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "" });
        expect(response.status).toBe(401);
        await response.arrayBuffer();
      }
      // The file was not written again.
      const after = statSync(file);
      expect([after.ino, after.mtimeMs]).toEqual([written.ino, written.mtimeMs]);

      const attempts = flooded.listAttempts();
      expect(attempts.filter((attempt) => attempt.outcome === "accepted").map((attempt) => attempt.deliveryId)).toEqual(["real-1"]);
      const rejected = attempts.filter((attempt) => attempt.outcome === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({ statusCode: 401, reason: "Invalid webhook URL or secret (2100 requests)" });
      // Clients get one record, updated in place, not 2,100 new ones.
      expect(emitted.size).toBe(2);

      // The rolling record is saved with the next real change.
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
      // the listener itself is still local: the public base only changes what is advertised
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

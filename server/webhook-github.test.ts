import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listenWebhookIngress, MAX_WEBHOOK_BODY_BYTES, type WebhookIngress } from "./webhook-ingress.ts";
import { WEBHOOK_KEY_FILE, WebhookManager } from "./webhooks.ts";

let dir: string;
let manager: WebhookManager;
let ingress: WebhookIngress;
let id: string;
let endpointId: string;
let secret: string;
let pending: number;
const queued: Array<{ prompt: string; deliveryId: string }> = [];
const body = '{ "action": "opened", "repository": { "full_name": "acme/widgets" }, "pull_request": { "number": 7, "title": "Fix café" } }';
const signature = (raw: string | Buffer, key = secret) => `sha256=${createHmac("sha256", key).update(raw).digest("hex")}`;

function loadManager() {
  return new WebhookManager({
    file: join(dir, "webhooks.json"),
    botState: () => "ready",
    pendingRuns: () => pending,
    enqueue: (input) => {
      queued.push(input);
      return { id: `run-${queued.length}` };
    },
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "omb-github-webhook-"));
  queued.length = 0;
  pending = 0;
  manager = loadManager();
  const created = manager.create({ name: "Review PRs", prompt: "Review opened PRs in acme/widgets.", botId: "bot-1", eventTypes: ["pull_request"] });
  ({ id, endpointId } = created.webhook);
  secret = created.secret;
  ingress = await listenWebhookIngress(manager, { port: 0 });
});

afterEach(async () => {
  await new Promise<void>((resolve) => ingress.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function send(raw: string | Buffer = body, headers: Record<string, string> = {}, endpoint = endpointId) {
  return fetch(`${ingress.baseUrl}/hooks/${endpoint}/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": "delivery-1", "x-hub-signature-256": signature(raw), ...headers },
    body: raw,
  });
}

describe("signed GitHub webhook ingress", () => {
  it("authenticates the raw body without a URL secret and deduplicates GitHub retries", async () => {
    const first = await send(body, { "idempotency-key": "unrelated-1", "x-webhook-event": "push" });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ runId: "run-1", duplicate: false, deliveryId: "delivery-1" });
    pending = 100;
    const retry = await send(body, { "idempotency-key": "unrelated-2" });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ runId: "run-1", duplicate: true });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.prompt).toContain("Event: pull_request");
    expect(queued[0]?.prompt).toContain("Fix café");
    expect(queued[0]?.prompt).not.toContain(secret);
    expect(JSON.stringify(manager.list())).not.toContain(secret);
    expect(readFileSync(join(dir, "webhooks.json"), "utf8")).not.toContain(secret);
  });

  it.each(["", "sha1=" + "a".repeat(40), "sha256=bad", "sha256=" + "0".repeat(64)])("rejects signature %j even with a bearer secret", async (value) => {
    expect((await send(body, { "x-hub-signature-256": value, authorization: `Bearer ${secret}` })).status).toBe(401);
    expect(queued).toHaveLength(0);
    expect(manager.listAttempts()).toEqual([]);
  });

  it("rejects changed bodies and unknown endpoints before parsing JSON", async () => {
    expect((await send(body + " ", { "x-hub-signature-256": signature(body) })).status).toBe(401);
    expect((await send("{", { "x-hub-signature-256": signature(body) })).status).toBe(401);
    expect((await send(body, {}, "wh_unknown")).status).toBe(401);
    expect((await send("{")).status).toBe(400);
    expect(queued).toHaveLength(0);
  });

  it("requires GitHub delivery and event headers", async () => {
    for (const header of ["x-github-delivery", "x-github-event"]) {
      expect((await send(body, { [header]: "" })).status).toBe(401);
    }
    expect(queued).toHaveLength(0);
  });

  it("signs bytes before UTF-8 decoding and keeps the body limit", async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x61]);
    expect((await send(bytes, { "content-type": "text/plain", "x-hub-signature-256": signature(bytes.toString("utf8")) })).status).toBe(401);
    expect((await send(bytes, { "content-type": "text/plain" })).status).toBe(202);
    expect((await send("x".repeat(MAX_WEBHOOK_BODY_BYTES + 1))).status).toBe(413);
    expect(queued).toHaveLength(1);
  });

  it("keeps pause, event selection and queue admission checks", async () => {
    manager.update(id, { enabled: false });
    expect((await send()).status).toBe(409);
    manager.update(id, { enabled: true });
    const ignored = await send(body, { "x-github-event": "push" });
    expect(ignored.status).toBe(202);
    expect(await ignored.json()).toMatchObject({ ignored: true });
    pending = 100;
    expect((await send()).status).toBe(429);
    expect(queued).toHaveLength(0);
  });

  it("uses the kept secret and delivery receipts after restart, and refuses an old signature after rotation", async () => {
    expect((await send()).status).toBe(202);
    await new Promise<void>((resolve) => ingress.server.close(() => resolve()));
    manager = loadManager();
    ingress = await listenWebhookIngress(manager, { port: 0 });
    expect(await (await send()).json()).toMatchObject({ duplicate: true, runId: "run-1" });
    const rotated = manager.rotateSecret(id)!;
    expect((await send()).status).toBe(401);
    secret = rotated.secret;
    expect((await send(body, { "x-github-delivery": "delivery-2" })).status).toBe(202);
    expect(queued).toHaveLength(2);
  });

  it("fails closed when the encrypted secret is unavailable", async () => {
    const path = join(dir, "webhooks.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    delete saved.webhooks[0].sealedSecret;
    writeFileSync(path, JSON.stringify(saved));
    await new Promise<void>((resolve) => ingress.server.close(() => resolve()));
    manager = loadManager();
    ingress = await listenWebhookIngress(manager, { port: 0 });
    expect((await send()).status).toBe(401);
    expect(queued).toHaveLength(0);
  });

  async function seedAcceptedHistory() {
    expect((await send()).status).toBe(202);
    await new Promise<void>((resolve) => ingress.server.close(() => resolve()));
    const path = join(dir, "webhooks.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    for (let i = 0; i < 1999; i++) {
      saved.attempts.push({ id: `seed-${i}`, webhookId: id, receivedAt: Date.now(), outcome: "rejected", statusCode: 429 });
    }
    writeFileSync(path, JSON.stringify(saved));
    manager = loadManager();
    ingress = await listenWebhookIngress(manager, { port: 0 });
    return { path, before: readFileSync(path, "utf8"), attempts: manager.listAttempts() };
  }

  it.each(["", "sha256=bad", "sha256=" + "0".repeat(64)])("does not persist or evict accepted history for oversized bodies with signature %j", async (value) => {
    const { path, before, attempts } = await seedAcceptedHistory();
    for (let i = 0; i < 3; i++) {
      const response = await send("x".repeat(MAX_WEBHOOK_BODY_BYTES + 1), { "x-hub-signature-256": value });
      expect([401, 413]).toContain(response.status);
      await response.arrayBuffer();
    }
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(manager.listAttempts()).toEqual(attempts);
    expect(queued).toHaveLength(1);
    expect(await (await send()).json()).toMatchObject({ duplicate: true, runId: "run-1" });
  });

  it.each(["", "sha256=" + "0".repeat(64)])("does not persist or evict accepted history for truncated bodies with signature %j", async (value) => {
    const { path, before, attempts } = await seedAcceptedHistory();
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(ingress.port, "127.0.0.1", () => socket.end(
        `POST /hooks/${endpointId}/github HTTP/1.1\r\nHost: localhost\r\nX-GitHub-Event: pull_request\r\nX-GitHub-Delivery: truncated\r\nX-Hub-Signature-256: ${value}\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{`,
      ));
      socket.on("data", () => {});
      socket.on("error", reject);
      socket.on("close", () => resolve());
    });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(manager.listAttempts()).toEqual(attempts);
    expect(queued).toHaveLength(1);
  });

  it("does not evict accepted history for unauthenticated malformed JSON", async () => {
    const { path, before, attempts } = await seedAcceptedHistory();
    expect((await send("{", { "x-hub-signature-256": signature(body) })).status).toBe(401);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(manager.listAttempts()).toEqual(attempts);
  });

  it("uses GitHub delivery metadata for authenticated parse rejections", async () => {
    expect((await send("{", { "idempotency-key": "wrong-generic-id", "x-webhook-id": "wrong-webhook-id", "x-github-delivery": "gh-parse-1" })).status).toBe(400);
    expect(manager.listAttempts()).toMatchObject([{ statusCode: 400, deliveryId: "gh-parse-1", eventName: "pull_request" }]);
    const response = await fetch(`${ingress.baseUrl}/hooks/${endpointId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "idempotency-key": "generic-parse-1", "x-github-delivery": "gh-parse-2" },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(manager.listAttempts().at(-1)).toMatchObject({ statusCode: 400, deliveryId: "generic-parse-1" });
  });

  it.each(["legacy", "missing key", "corrupt seal"])("gives the owner a bounded recovery diagnostic for a %s secret", async (failure) => {
    await new Promise<void>((resolve) => ingress.server.close(() => resolve()));
    const path = join(dir, "webhooks.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (failure === "legacy") delete saved.webhooks[0].sealedSecret;
    else if (failure === "missing key") rmSync(join(dir, WEBHOOK_KEY_FILE));
    else saved.webhooks[0].sealedSecret = "invalid";
    writeFileSync(path, JSON.stringify(saved));
    manager = loadManager();
    ingress = await listenWebhookIngress(manager, { port: 0 });
    const before = readFileSync(path, "utf8");
    for (let i = 0; i < 20; i++) {
      const response = await send();
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('{"error":"Invalid webhook URL or secret"}');
    }
    const attempts = manager.listAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.reason).toMatch(/replace.*address/i);
    expect(attempts[0]?.reason).toMatch(/GitHub.*Secret/);
    expect(attempts[0]?.reason).toContain("20 requests");
    expect(attempts[0]?.reason!.length).toBeLessThan(500);
    expect(JSON.stringify(attempts)).not.toContain(secret);
    expect(JSON.stringify(attempts)).not.toContain(saved.webhooks[0].secretHash);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(queued).toHaveLength(0);
    expect(manager.authorize(endpointId, secret)).toBe(true);
    const rotated = manager.rotateSecret(id)!;
    secret = rotated.secret;
    expect((await send()).status).toBe(202);
  });

});

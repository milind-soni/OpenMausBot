import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BrowserEvidence } from "../browser-evidence.ts";
import { json, readBody } from "../harness/http.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { createBrowserEvidenceRoutes } from "./browser-evidence.ts";
import { dispatchRoutes } from "./table.ts";

const GEN = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0)) await step(); });

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), "omb-evidence-routes-"));
  const evidence = new BrowserEvidence({ root: join(dir, "evidence") });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const record = async (threadId: string, picture: Buffer | null) => {
    const step = evidence.nextStep();
    const slot = picture ? evidence.imageTarget(threadId, GEN, step) : { skipped: "secret-on-screen" };
    if ("path" in slot) writeFileSync(slot.path, picture!);
    return evidence.commit({ v: 1, step, at: 1, threadId, generation: GEN, image: null, action: "Clicked", ...("skipped" in slot ? { imageSkipped: slot.skipped } : {}) }, "path" in slot ? slot.path : null);
  };
  const routes = [createBrowserEvidenceRoutes({ evidence, threadExists: (id) => id.startsWith("thread-") })];
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "inline routes" });
  });
  cleanup.push(() => new Promise((done) => server.close(done)));
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, record, evidence };
}

describe("recorded browser step routes", () => {
  it("lists a conversation's steps with each screenshot's address, and pages with `after`", async () => {
    const { base, record } = await serve();
    const one = await record("thread-1", Buffer.from("jpeg one"));
    await record("thread-1", null);
    await record("thread-1", Buffer.from("jpeg three"));
    const response = await fetch(`${base}/api/threads/thread-1/evidence?limit=2`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { threadId: string; steps: Array<{ step: number; imageUrl: string | null; imageSkipped?: string }>; nextAfter: number | null };
    expect(body.threadId).toBe("thread-1");
    expect(body.steps.map((step) => [step.step, step.imageUrl, step.imageSkipped ?? null])).toEqual([
      [1, `/api/threads/thread-1/evidence/${GEN}/${one.image}`, null], [2, null, "secret-on-screen"],
    ]);
    expect(body.nextAfter).toBe(2);
    const rest = await (await fetch(`${base}/api/threads/thread-1/evidence?after=2`)).json() as { steps: Array<{ step: number }>; nextAfter: null };
    expect(rest).toMatchObject({ steps: [{ step: 3 }], nextAfter: null });
  });

  it("serves a screenshot as an uncached private JPEG, and nothing else", async () => {
    const { base, record } = await serve();
    const one = await record("thread-1", Buffer.from("jpeg bytes"));
    const image = await fetch(`${base}/api/threads/thread-1/evidence/${GEN}/${one.image}`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/jpeg");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(image.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await image.arrayBuffer()).toString()).toBe("jpeg bytes");
    for (const path of [`/api/threads/thread-1/evidence/${GEN}/step-999999.jpg`, `/api/threads/other/evidence/${GEN}/${one.image}`, `/api/threads/other/evidence`]) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(404);
    }
    const gone = await record("gone-1", Buffer.from("jpeg of a deleted conversation"));
    for (const path of [`/api/threads/gone-1/evidence/${GEN}/${gone.image}`, "/api/threads/gone-1/evidence.tar", "/api/threads/gone-1/evidence"]) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(404);
    }
    expect(await (await fetch(`${base}/api/threads/thread-1/evidence/${GEN}/..%2Fsteps.jsonl`)).json()).toEqual({ from: "inline routes" });
    expect((await fetch(`${base}/api/threads/thread-1/evidence?limit=0`)).status).toBe(400);
    expect((await fetch(`${base}/api/threads/thread-1/evidence?generation=../x`)).status).toBe(400);
  });

  it("downloads the whole conversation's evidence as a tar", async () => {
    const { base, record } = await serve();
    await record("thread-1", Buffer.from("jpeg"));
    const archive = await fetch(`${base}/api/threads/thread-1/evidence.tar`);
    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toBe("application/x-tar");
    expect(archive.headers.get("content-disposition")).toBe('attachment; filename="browser-steps-thread-1.tar"');
    const bytes = Buffer.from(await archive.arrayBuffer());
    expect(bytes.length % 512).toBe(0);
    expect(bytes.subarray(0, 10).toString()).toBe("index.json");
  });

  it("is read like the transcript: open to a client session, every other method admin-only", () => {
    expect(requiredScope("GET", "/api/threads/t1/evidence")).toBe("client");
    expect(requiredScope("GET", "/api/threads/t1/evidence.tar")).toBe("client");
    expect(requiredScope("GET", `/api/threads/t1/evidence/${GEN}/step-000042.jpg`)).toBe("client");
    expect(requiredScope("DELETE", "/api/threads/t1/evidence")).toBe("admin");
    expect(requiredScope("GET", `/api/threads/t1/evidence/${GEN}/steps.jsonl`)).toBe("admin");
  });
});

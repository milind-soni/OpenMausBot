import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { createSkillBurgerRuns, RESUME_PATH, RUN_PATH } from "./runs.ts";
import type { RunEnvelope } from "./runner.ts";
import { saveWorkflowSkill } from "./store.ts";

function latch() {
  let done!: () => void;
  const promise = new Promise<void>((resolve) => { done = resolve; });
  return { promise, release: () => done() };
}

function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("request did not finish")), 3_000); })]).finally(() => clearTimeout(timer));
}

async function exercise(mode: string, disconnect: boolean) {
  const root = mkdtempSync(join(tmpdir(), "burger-disconnect-"));
  const entered = latch();
  const release = latch();
  const closed = latch();
  const completed = latch();
  const errors: unknown[] = [];
  const path = mode === "resume" ? RESUME_PATH : RUN_PATH;
  const calling = { botId: "reporter", threadId: "weekly", generation: "turn-1" };
  const saved = saveWorkflowSkill({ name: "disconnect-report", origin: calling.botId, botIds: [], root, workflow: {
    version: 1, summary: "Make a report", args: {}, steps: [
      ...(mode === "resume" ? [{ id: "review", kind: "ai", deterministic: false, label: "Review request", prompt: "Review the request." }] : []),
      { id: "draft", kind: "app", app: "gmail", tool: "gmail.create_draft", label: "Create draft", args: { to: "priya@example.com", subject: "Report", body: "Ready" } },
      { id: "receipt", kind: "file", label: "Write receipt", path: "receipt.txt", content: { $step: "draft", path: "id" } },
    ],
  } });
  if ("error" in saved) throw new Error(saved.error);
  let runs!: ReturnType<typeof createSkillBurgerRuns>;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const target = url.pathname === path;
    if (target) res.once("close", closed.release);
    try {
      if (url.pathname === "/api/internal/connectors/mcp") {
        await readBody(req);
        entered.release();
        await release.promise;
        if (!res.destroyed) json(res, 200, { result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { id: "draft-current" } }) }] } });
        return;
      }
      await dispatchRoutes([runs.routesFor(calling, "Bearer fixture-capability")], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: {} as RequestAuth, json, readBody });
    } catch (error) {
      errors.push(error);
      if (!res.destroyed) json(res, 500, { error: String(error) });
    } finally {
      if (target) completed.release();
    }
  });
  let client: ClientRequest | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    runs = createSkillBurgerRuns({ dataDir: root, root, host: {
      port, cwd: () => root, mint: () => "fixture-capability", browser: async () => null, publish: () => {}, mayEditBurgers: () => true,
    } });
    let body: Record<string, unknown> = { name: saved.name };
    if (mode === "resume") {
      const paused = await (await fetch(`${base}${RUN_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as RunEnvelope;
      expect(paused.requiresInput).toMatchObject({ type: "ai_step" });
      body = { run: paused.run, response: "ready" };
    }
    const response = new Promise<RunEnvelope>((resolve, reject) => {
      client = request(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
      });
      client.on("error", reject);
      client.end(JSON.stringify(body));
    });
    void response.catch(() => {});
    await bounded(entered.promise);
    if (disconnect) {
      client!.destroy();
      await bounded(closed.promise);
      release.release();
      await response.catch(() => {});
    } else {
      release.release();
      expect(await bounded(response)).toMatchObject({ ok: true, status: "ok" });
    }
    await bounded(completed.promise);
    expect(errors).toEqual([]);
    expect(existsSync(join(root, "receipt.txt"))).toBe(!disconnect);
    if (!disconnect) expect(readFileSync(join(root, "receipt.txt"), "utf8")).toBe("draft-current");
  } finally {
    release.release();
    client?.destroy();
    await bounded(completed.promise).catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

it.each(["run", "resume"])("stops later actions when the %s caller disconnects", async (mode) => { await exercise(mode, true); });
it.each(["run", "resume"])("completes a normal %s request without treating its response close as cancellation", async (mode) => { await exercise(mode, false); });

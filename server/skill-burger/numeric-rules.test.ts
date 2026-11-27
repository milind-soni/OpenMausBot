import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { onCase, workflowSchema } from "../../shared/skill-burger/format.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { createSkillBurgerRoutes } from "./routes.ts";
import type { RunEnvelope } from "./runner.ts";
import { createSkillBurgerRuns, RESUME_PATH, RUN_PATH } from "./runs.ts";

// The replayed shell steps are quoted for /bin/sh. Under cmd.exe on Windows CI they left no file and no output while the run
// still reported ok, so these cases skip Windows like the other shell-replay tests (working-directory, recorded-inputs).
const POSIX_ONLY = process.platform === "win32";
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const file = (id: string, when?: unknown) => ({ id, kind: "file", label: id, path: `${id}.txt`, content: "ran", ...(when ? { when } : {}) });
const condition = (op: string, value?: unknown) => ({ $step: "read", path: "count", op, value });

async function serve(value: unknown, tail: unknown[], check?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "burger-numeric-rules-"));
  roots.push(root);
  writeFileSync(join(root, "source.json"), JSON.stringify({ count: value }));
  const workflow = workflowSchema.parse({
    version: 1, summary: "Check the reported count", args: {},
    steps: [{ id: "read", kind: "shell", label: "Read count", run: "node -e \"process.stdout.write(require('node:fs').readFileSync('source.json'))\"", ...(check ? { check } : {}) }, ...tail],
  });
  const routes = createSkillBurgerRoutes({ root, messages: () => [], owns: () => true, sees: () => true, botIds: () => ["lead"] });
  let runs = createSkillBurgerRuns({ root, dataDir: root });
  const turn = { botId: "lead", threadId: "count", cwd: root, mayEditBurgers: true, publish() {}, internal: async () => { throw new Error("unexpected external call"); } };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    if (!await dispatchRoutes([routes, runs.internalRoutes(turn)], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async <T>(path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json() as T;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const saved = await api<{ skill: { name: string } }>("/api/skill-burgers", { name: "check-the-count", botId: "lead", workflow });
  const read = await api<{ workflow: unknown }>(`/api/skill-burgers/${saved.skill.name}`);
  expect(workflowSchema.parse(read.workflow)).toEqual(workflow);
  return {
    root,
    ran: (id: string) => existsSync(join(root, `${id}.txt`)),
    run: () => api<RunEnvelope>(RUN_PATH, { name: saved.skill.name }),
    resume: (run: string) => {
      runs = createSkillBurgerRuns({ root, dataDir: root });
      return api<RunEnvelope>(RESUME_PATH, { run, response: "A numeric count is now available." });
    },
  };
}

it.skipIf(POSIX_ONLY).each([null, undefined, false, "", " \t", [], [0], "Infinity", "-Infinity", "NaN"].map((value) => ({ value })))("does not run numeric branches for a count of $value", async ({ value }) => {
  const h = await serve(value, [file("below", condition("lt", 1)), file("above", condition("gt", -1)), file("complete")]);
  expect(await h.run()).toMatchObject({ ok: true, status: "ok" });
  expect(h.ran("below")).toBe(false);
  expect(h.ran("above")).toBe(false);
  expect(h.ran("complete")).toBe(true);
});

it.skipIf(POSIX_ONLY).each([
  { value: 0, below: true }, { value: -2, below: true }, { value: 2.5, below: false }, { value: " 2.5 ", below: false },
])("keeps numeric comparison for $value", async ({ value, below }) => {
  const h = await serve(value, [file("below", condition("lt", 1)), file("above", condition("gt", 1)), file("complete")]);
  expect(await h.run()).toMatchObject({ ok: true, status: "ok" });
  expect(h.ran("below")).toBe(below);
  expect(h.ran("above")).toBe(!below);
});

it.skipIf(POSIX_ONLY).each([null, "", [], "Infinity"].map((threshold) => ({ threshold })))("does not run a numeric branch with a nonnumeric threshold of $threshold", async ({ threshold }) => {
  const h = await serve(5, [file("below", condition("lt", threshold)), file("above", condition("gt", threshold)), file("complete")]);
  expect(await h.run()).toMatchObject({ ok: true, status: "ok" });
  expect(h.ran("below")).toBe(false);
  expect(h.ran("above")).toBe(false);
});

it.skipIf(POSIX_ONLY)("uses the otherwise case when a numeric decision has no reported count", async () => {
  const h = await serve(null, [
    { id: "choose", kind: "decide", label: "Choose a count path", cases: ["low", "unknown"], rules: [{ ...condition("lt", 1), case: "low" }], otherwise: "unknown" },
    file("low", onCase("choose", "low")), file("unknown", onCase("choose", "unknown")),
  ]);
  expect(await h.run()).toMatchObject({ ok: true, status: "ok", steps: expect.arrayContaining([{ id: "choose", label: "Choose a count path", state: "done", case: "unknown" }]) });
  expect(h.ran("low")).toBe(false);
  expect(h.ran("unknown")).toBe(true);
});

it.skipIf(POSIX_ONLY)("fails a numeric check on null and resumes from disk once the source contains zero", async () => {
  const h = await serve(null, [file("complete")], { says: "A numeric count was received and is below one", rule: { path: "count", op: "lt", value: 1 } });
  const stopped = await h.run();
  expect(stopped).toMatchObject({ ok: false, error: { type: "step_failed", step: "read", message: expect.stringContaining("its check didn't hold") } });
  expect(h.ran("complete")).toBe(false);
  writeFileSync(join(h.root, "source.json"), JSON.stringify({ count: 0 }));
  expect(await h.resume(stopped.run)).toMatchObject({ ok: true, status: "ok" });
  expect(readFileSync(join(h.root, "complete.txt"), "utf8")).toBe("ran");
});

it.skipIf(POSIX_ONLY)("leaves boolean equality and existence conditions intact", async () => {
  const h = await serve(false, [file("equals", condition("eq", false)), file("exists", condition("exists"))]);
  expect(await h.run()).toMatchObject({ ok: true, status: "ok" });
  expect(h.ran("equals")).toBe(true);
  expect(h.ran("exists")).toBe(true);
});

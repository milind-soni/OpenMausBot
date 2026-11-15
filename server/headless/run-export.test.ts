import "../testing/scrub-ambient-omb-env.ts";

import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { runHeadless, runHeadlessCommand } from "./main.ts";
import type { HeadlessIo } from "./output.ts";

const dir = mkdtempSync(join(tmpdir(), "omb-run-export-status-"));
let server: Server;
let origin: string;
let state = "completed";
let refuseExport = true;
let sends = 0;
let exports = 0;
let sequence = 0;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url ?? "/", "http://localhost");
    const answer = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/api/bots") return answer(200, {
      bots: [{ id: "lead", name: "Room Lead", threadId: "t1", tasks: [{ threadId: "t1" }] }], groups: [],
    });
    if (url.pathname === "/api/bots/lead/messages" && req.method === "POST") {
      sends++;
      return answer(200, { message: { id: "m1", at: 1_000, text: JSON.parse(body).text } });
    }
    if (url.pathname === "/api/threads/t1/job") {
      if (url.searchParams.get("full") === "1") {
        exports++;
        if (refuseExport) return answer(503, { error: "workspace temporarily unavailable" });
      }
      return answer(200, { threadId: "t1", state, version: "v1", since: 1_000, now: 1_000, reason: state, nodes: [], counts: {} });
    }
    if (url.pathname === "/api/threads/t1/messages" || url.pathname === "/api/threads/t1/export") {
      return answer(200, { name: "Report", messages: [{ id: "r1", role: "bot", kind: "text", text: "The report is ready." }] });
    }
    answer(404, { error: "unexpected fixture route" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => { state = "completed"; refuseExport = true; sends = 0; exports = 0; });
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await removeTempDir(dir);
});

async function run(programmatic = false) {
  const out = join(dir, String(sequence++));
  const argv = ["run", "--bot", "lead", "--task", "t1", "Write the report", "--export", out, "--json"];
  const stdout: string[] = [];
  const io: HeadlessIo = { out: (text) => stdout.push(text), err: () => undefined, readStdin: async () => "" };
  const options = { env: { OPENMAUSBOT_URL: origin }, io };
  if (programmatic) return { result: await runHeadlessCommand(argv, options), out };
  const code = await runHeadless(argv, options);
  return { code, result: JSON.parse(stdout.join("\n")), out };
}

it.each([false, true])("reports a failed export after a completed job (programmatic: %s)", async (programmatic) => {
  const { code, result } = await run(programmatic);
  if (!programmatic) expect(code).toBe(1);
  expect(result).toMatchObject({ ok: false, exitCode: 1, state: "completed", export: { ok: false, error: expect.stringContaining("503") } });
  expect(sends).toBe(1);
  expect(exports).toBe(1);
});

it("keeps a completed run successful when its export is written", async () => {
  refuseExport = false;
  const { code, result, out } = await run();
  expect(code).toBe(0);
  expect(result).toMatchObject({ ok: true, exitCode: 0, state: "completed", export: { ok: true } });
  expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"))).toMatchObject({ ok: true, threadId: "t1" });
  expect(sends).toBe(1);
});

it.each([["needs-input", 3], ["failed", 1]] as const)("preserves the %s job's exit code when export also fails", async (jobState, expectedCode) => {
  state = jobState;
  const { code, result } = await run();
  expect(code).toBe(expectedCode);
  expect(result).toMatchObject({ ok: false, exitCode: expectedCode, state: jobState, export: { ok: false } });
});

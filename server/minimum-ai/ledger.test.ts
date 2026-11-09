import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createRunLedger } from "./ledger.ts";

const folders: string[] = [];
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function file() { const dir = mkdtempSync(join(tmpdir(), "omb-workflow-run-")); folders.push(dir); return join(dir, "runs.json"); }
it("records completion and never starts the same run twice", () => {
  const path = file(); const ledger = createRunLedger(path);
  expect(ledger.begin("run-1")).toBe(true);
  expect(ledger.begin("run-1")).toBe(false);
  ledger.finish("run-1", "completed");
  const reopened = createRunLedger(path);
  expect(reopened.begin("run-1")).toBe(false);
  expect(reopened.status("run-1")).toBe("completed");
});
it("marks a run interrupted by restart as uncertain and never retries it", () => {
  const path = file(); const ledger = createRunLedger(path);
  ledger.begin("run-2");
  const reopened = createRunLedger(path);
  reopened.recoverInterrupted();
  expect(reopened.status("run-2")).toBe("interrupted");
  expect(reopened.begin("run-2")).toBe(false);
});
it("prevents two ledger instances from starting the same run", () => {
  const path = file(); const first = createRunLedger(path); const second = createRunLedger(path);
  expect(first.begin("same-run")).toBe(true);
  expect(second.begin("same-run")).toBe(false);
});
it("does not mark another live run interrupted when another reader opens the ledger", () => {
  const path = file(); const first = createRunLedger(path); first.begin("active");
  const second = createRunLedger(path);
  expect(second.status("active")).toBe("running");
  first.finish("active", "completed");
  expect(second.status("active")).toBe("completed");
});
it("prevents overlapping runs and recovers a dead process without repeating its run", () => {
  const path = file(); const first = createRunLedger(path); const second = createRunLedger(path);
  expect(first.begin("run-1", "routine")).toBe(true);
  expect(second.begin("run-2", "routine")).toBe(false);
  const db = new DatabaseSync(path);
  db.prepare("UPDATE runs SET pid = ? WHERE id = ?").run(2_147_483_647, "run-1");
  db.close();
  expect(second.begin("run-2", "routine")).toBe(false);
  expect(second.status("run-1")).toBe("interrupted");
  expect(second.held("routine")).toBe(true);
  expect(second.begin("run-3", "routine")).toBe(false);
  second.acknowledge("routine");
  expect(second.begin("run-2", "routine")).toBe(true);
  expect(second.begin("run-1", "routine")).toBe(false);
});
it("holds a real interrupted child-process run until it is acknowledged", async () => {
  const path = file();
  const moduleUrl = pathToFileURL(join(process.cwd(), "server/minimum-ai/ledger.ts")).href;
  const code = `import { createRunLedger } from ${JSON.stringify(moduleUrl)}; const ledger = createRunLedger(${JSON.stringify(path)}); ledger.begin("run-1", "routine"); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await once(child.stdout, "data");
    child.kill("SIGKILL");
    await once(child, "exit");
    const ledger = createRunLedger(path);
    expect(ledger.held("routine")).toBe(true);
    expect(ledger.status("run-1")).toBe("interrupted");
    expect(ledger.begin("run-2", "routine")).toBe(false);
    ledger.acknowledge("routine");
    expect(ledger.begin("run-2", "routine")).toBe(true);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
});

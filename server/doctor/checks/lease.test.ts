import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { backupFolder, context, dataFolder, deadPid, NOW } from "../../testing/doctor-folders.ts";
import { runDoctor } from "../run.ts";
import { leaseCheck } from "./lease.ts";

const LEASE = "openmausbot-server.lease";
const lease = (data: string, pid: number) => {
  const record = `${JSON.stringify({ version: 1, pid, host: hostname(), token: randomUUID(), createdAt: Date.now() })}\n`;
  writeFileSync(join(data, LEASE), record, { mode: 0o600 });
  return record;
};
const run = (data: string, fix = true) => runDoctor({ dataDir: data, version: "9.9.9", mode: "command", fix, now: () => NOW, checks: [leaseCheck()] });

describe("lease check", () => {
  it("is the server's own as it starts", () => {
    expect(leaseCheck().check(context(dataFolder(), { mode: "start" }))).toMatchObject({ status: "ok", summary: "This server holds it." });
  });

  it("finds no lease fine", () => {
    expect(leaseCheck().check(context(dataFolder())).status).toBe("ok");
  });

  it("retires a lease a dead process of this machine left, keeping a copy, by taking the lease and letting it go", () => {
    const data = dataFolder();
    const record = lease(data, deadPid());
    expect(leaseCheck().check(context(data))).toMatchObject({ status: "problem", fixable: true });

    const report = run(data);
    expect(report.checks[0]).toMatchObject({ id: "lease", status: "fixed" });
    expect(existsSync(join(data, LEASE))).toBe(false);
    expect(readFileSync(join(backupFolder(data)!, LEASE), "utf8")).toBe(record);
  });

  it("changes nothing while a live process holds the lease", () => {
    const data = dataFolder();
    const record = lease(data, process.pid);
    expect(leaseCheck().check(context(data))).toMatchObject({ status: "ok" });
    const report = run(data);
    expect(report.fix).toMatchObject({ ran: false });
    expect(report.fix.why).toContain(`process ${process.pid}`);
    expect(readFileSync(join(data, LEASE), "utf8")).toBe(record);
    expect(backupFolder(data)).toBeNull();
  });

  it("reports another machine's lease with what to do, and changes nothing", () => {
    const data = dataFolder();
    const other = leaseCheck(() => ({ state: "other-machine", path: join(data, LEASE), pid: 42, host: "elsewhere", createdAt: NOW }));
    const report = runDoctor({ dataDir: data, version: "9.9.9", mode: "command", fix: true, now: () => NOW, checks: [other], acquireLease: () => { throw new Error("must not be taken"); } });
    expect(report.checks[0]).toMatchObject({ status: "problem", fixable: false });
    expect(report.checks[0]!.instruction).toContain("delete");
    expect(report.fix.ran).toBe(false);
  });

  it("reports a lease record that cannot be read", () => {
    const data = dataFolder();
    writeFileSync(join(data, LEASE), "{not json");
    expect(leaseCheck().check(context(data))).toMatchObject({ status: "problem", summary: "The lease record cannot be read." });
    expect(run(data).fix.ran).toBe(false);
  });
});

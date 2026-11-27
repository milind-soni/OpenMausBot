import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { verifyWorkspaceBackup } from "../scripts/verify-workspace-backup.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { commitPendingWorkspaceRestore, createWorkspaceBackup, stageWorkspaceBackup } from "./workspace-backup.ts";

it("starts the server with the original workspace after an interrupted restore preparation", async () => {
  const fixture = await launchVerificationServer({});
  const source = mkdtempSync(join(tmpdir(), "omb-restore-prepare-"));
  let restarted: ChildProcess | undefined;
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    writeFileSync(join(source, "note.txt"), "new workspace");
    const target = fixture.info.dataDir;
    writeFileSync(join(target, "note.txt"), "original workspace");
    const password = "fixture-backup-password-only";
    const exported = await createWorkspaceBackup(source, { password });
    const staged = await stageWorkspaceBackup(target, exported.path, { password });
    commitPendingWorkspaceRestore(target, staged.id);
    mkdirSync(join(target, ".backups", `safety-${staged.id}`, "data"), { recursive: true });
    const env = verificationServerEnvironment({}, join(source, "home"), Number(new URL(fixture.info.url).port));
    env.OMB_DATA_DIR = target;
    mkdirSync(env.TMPDIR!, { recursive: true });
    const log = openSync(fixture.info.logPath, "a", 0o600);
    try {
      restarted = spawn(process.execPath, verificationServerArgs(env), { env, stdio: ["ignore", log, log] });
    } finally { closeSync(log); }
    await expect.poll(async () => {
      try {
        const response = await fetch(`${fixture.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) });
        const health = await response.json() as { pid?: number };
        return response.ok && health.pid === restarted!.pid;
      } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    const response = await fetch(`${fixture.info.url}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ app: "openmausbot", pid: restarted.pid });
    expect(readFileSync(join(target, "note.txt"), "utf8")).toBe("original workspace");
    expect(existsSync(join(target, ".backups", "pending-restore.json"))).toBe(false);
  } finally {
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    rmSync(source, { recursive: true, force: true });
  }
}, 60_000);

it("restores an encrypted workspace through the real server and continues its original chat", async () => {
  const result = await verifyWorkspaceBackup();
  console.info(JSON.stringify(result));
  expect(result).toMatchObject({
    ok: true, identicalIds: true, transcriptPreserved: true, conversationContinued: true,
    attachmentBytesPreserved: true, skillAndProfilePreserved: true, sourceCredentialsExcluded: true, destinationCredentialsUnchanged: true,
    clientStateAllowlisted: true, oldDataSafetyCopy: true,
  });
}, 150_000);

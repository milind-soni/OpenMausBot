import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("exports long linked document names with their file types, including folder entries and collisions", async () => {
  const parentEnv = { ...process.env };
  const fixture = await launchVerificationServer(parentEnv);
  const { url, dataDir, logPath } = fixture.info;
  let restarted: ChildProcess | undefined;
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Report Writer", "--url", url]) as any;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const workspace = join(dataDir, "workspaces", bot.id);
    const documents = [
      { name: `${"annual-financial-report-".repeat(6)}approved.pdf`, text: "Approved annual report", folder: false },
      { name: `${"季度营业收入与支出汇总表".repeat(5)}第一季.xlsx`, text: "First quarter workbook", folder: true },
      { name: `${"季度营业收入与支出汇总表".repeat(5)}第二季.xlsx`, text: "Second quarter workbook", folder: true },
    ];
    mkdirSync(join(workspace, "deliverables"), { recursive: true });
    for (const document of documents) {
      writeFileSync(join(workspace, ...(document.folder ? ["deliverables"] : []), document.name), document.text);
    }
    const message = {
      id: "saved-report-links", at: Date.now(), role: "bot", kind: "text",
      text: `[Annual report](${encodeURIComponent(documents[0]!.name)})\n[Quarterly workbooks](deliverables/)`,
    };
    const db = new DatabaseSync(join(dataDir, "messages.db"));
    try {
      const previous = db.prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?").get(bot.activeTaskId);
      db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(bot.activeTaskId, message.id, message.at, message.role, message.kind, message.text,
          JSON.stringify({ ...message, parentId: previous?.active_leaf_id ?? null }));
      db.prepare("INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id = excluded.active_leaf_id")
        .run(bot.activeTaskId, message.id);
    } finally {
      db.close();
    }
    const env = verificationServerEnvironment(parentEnv, dataDir, Number(new URL(url).port));
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, verificationServerArgs(env), {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; }
      catch { return false; }
    }, { timeout: 30_000 }).toBe(true);
    expect(await runControlOmb(["doctor", "--url", url])).toMatchObject({ ok: true });

    const out = join(dataDir, "exported-reports");
    const result = await runControlOmb(["export", "--thread", bot.activeTaskId, "--out", out, "--url", url]) as any;
    expect(result.skipped).toEqual([]);
    expect(result.files).toHaveLength(documents.length);
    expect(new Set(result.files.map((file: any) => file.file)).size).toBe(documents.length);
    for (const document of documents) {
      const entry = result.files.find((file: any) => document.folder
        ? file.entry === document.name
        : file.link === encodeURIComponent(document.name));
      expect(entry).toBeDefined();
      expect(readFileSync(join(out, entry.file), "utf8")).toBe(document.text);
      expect(extname(entry.file)).toBe(extname(document.name));
      expect(Buffer.byteLength(basename(entry.file))).toBeLessThanOrEqual(124);
    }
    expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).files).toEqual(result.files);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);

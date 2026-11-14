import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("keeps an ACP partial reply in the transcript across graceful shutdown and restart", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["cline"]);
  const { dataDir, url, logPath } = fixture.info;
  const port = Number(new URL(url).port);
  let server = fixture.child;
  const start = async () => {
    const env = verificationServerEnvironment({}, dataDir, port);
    const log = openSync(logPath, "a", 0o600);
    // Windows child.kill("SIGTERM") terminates immediately without running Node's signal handlers.
    const bootstrap = `process.on('message', message => { if (message === 'stop') process.emit('SIGTERM'); });
      await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});`;
    server = spawn(process.execPath, [...verificationServerArgs(env).slice(0, -1), "--input-type=module", "-e", bootstrap], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log, "ipc"],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(`${url}/api/health`)).ok; } catch { return false; }
    }, { timeout: 30_000 }).toBe(true);
  };
  const stop = async () => {
    if (server.connected) {
      server.send("stop");
      await waitForExit(server, { graceMs: 10_000 });
    } else {
      await waitForExit(server, { signal: "SIGTERM" });
    }
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  try {
    await stop();
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.cline.environment.FAKE_ACP_MODE = "stall-after-text";
    writeFileSync(configPath, JSON.stringify(config));
    await start();

    const { bot } = await cli("new-bot", "--name", "Shutdown probe");
    await cli("set-model", "--bot", bot.id, "--instance", "cline", "--model", "cline-default");
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "hello");
    await expect.poll(() => {
      try {
        return readFileSync(join(dataDir, "events", `${bot.activeTaskId}.ndjson`), "utf8")
          .includes('"delta":"half an answer, then silence"');
      } catch { return false; }
    }, { timeout: 15_000 }).toBe(true);

    await stop();
    expect(server.exitCode).toBe(0);
    const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
    try {
      expect(db.prepare("SELECT text FROM messages WHERE thread_id = ? AND role = 'bot' AND kind = 'text' AND text = ?")
        .all(bot.activeTaskId, "half an answer, then silence")).toEqual([{ text: "half an answer, then silence" }]);
    } finally { db.close(); }

    await start();
    const transcript = await cli("messages", "--bot", bot.id, "--task", bot.activeTaskId, "--limit", "20");
    expect(JSON.stringify(transcript)).toContain("half an answer, then silence");
  } finally {
    await stop();
    await fixture.close();
  }
}, 90_000);

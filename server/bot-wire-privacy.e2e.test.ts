// The bot wire projection is the security boundary between server-private
// BotRecord fields and every client payload. BotWirePrivateKeys enforces the
// boundary at compile time, but a `...rest` spread does not fail typecheck
// when it carries a private key out — assignedSkills reached /api/bots
// exactly that way. This suite pins the projection at runtime, against the
// real server, with the private field live on the stored record both while
// the skills library flag is off and after it is switched on.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");

describe("bot wire privacy against the real server", () => {
  let home = "";
  let data = "";
  let output = "";
  let child: ChildProcess | null = null;
  let base = "";

  async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
    const end = Date.now() + 20_000;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }

  async function start(skillsLibrary: boolean) {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    output = "";
    writeFileSync(join(data, "config.json"), JSON.stringify({
      features: { skillsLibrary },
      instances: { grok: { driver: "grokAgent", config: { cli: FAKE_CLI, fullAuto: false } } },
    }));
    const proc = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data,
        APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", (chunk) => { output += chunk; });
    proc.stderr!.on("data", (chunk) => { output += chunk; });
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, Boolean);
  }

  async function stop() {
    if (!child) return;
    const proc = child;
    child = null;
    await waitForExit(proc, { signal: "SIGTERM" });
  }

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  beforeAll(() => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-bot-wire-privacy-"));
    data = join(home, "data");
    mkdirSync(data, { recursive: true });
  });
  afterAll(async () => {
    await stop();
    if (home) await removeTempDir(home);
  });
  afterEach(async () => { await stop(); });

  it("never serializes assignedSkills, flag off or on, even when the record carries assignments", async () => {
    await start(false);
    const created = await api("POST", "/api/bots", { name: "Wire Privacy Bot" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const botId = created.body.bot.id as string;
    await stop();

    // Seed the server-private field the way a flag-off-on-flag-on cycle or
    // an applied pending-assignments sweep leaves it behind on disk.
    const bots = JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as any[];
    bots.find((bot) => bot.id === botId)!.assignedSkills = ["some-library-skill"];
    writeFileSync(join(data, "bots.json"), JSON.stringify(bots, null, 2));

    for (const flag of [false, true]) {
      await start(flag);
      const listed = await api("GET", "/api/bots?messages=0");
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      expect(listed.body.bots.some((bot: any) => bot.id === botId)).toBe(true);
      expect(JSON.stringify(listed.body)).not.toContain("assignedSkills");
      await stop();
    }

    // The field was live on the record in the server that produced those
    // payloads — the assertion above was not checking an empty bot.
    const stored = (JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as any[]).find((bot) => bot.id === botId)!;
    expect(stored.assignedSkills).toEqual(["some-library-skill"]);
  });
});

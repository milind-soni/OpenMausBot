// A process that stays running in a real box (Linux with an unprivileged bubblewrap) for a turn in its bot's own folder,
// like an engine a room keeps between turns: a file the person attaches after it started is readable from inside it.
// Elsewhere the suite says so and skips.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BotBox } from "./box.ts";
import { detectBox } from "./detect.ts";
import { boxUploadsDir } from "./plan.ts";
import { attachmentsForBox } from "../box-attachments.ts";

const ENV = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", OMB_BOT_BOX: "1" };
const detection = detectBox({ env: ENV });

describe.skipIf(detection.box !== "bwrap")(`an upload added after a box in its bot's own folder started (${detection.box === "bwrap" ? "bubblewrap works here" : `skipped: ${detection.reason}`})`, () => {
  const root = mkdtempSync(join(tmpdir(), "omb-retained-upload-"));
  const home = join(root, "home"), dataDir = join(home, ".openmausbot"), uploads = join(dataDir, "attachments");
  const own = join(dataDir, "workspaces", "bot-a"), conversationFolder = join(dataDir, "task-workspaces", "bot-a", "room-1");
  const box = new BotBox();
  beforeAll(async () => {
    for (const dir of [uploads, own, conversationFolder]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    expect((await box.start({ dataDir, home, port: 1, env: ENV, denyEnv: new Set(), log: () => {} })).box).toBe("bwrap");
  });
  afterAll(async () => { await box.stop(); rmSync(root, { recursive: true, force: true }); });

  it("is readable from the box that was already running when it arrived", async () => {
    const shown = join(boxUploadsDir(dataDir, "bot-a", "room-1"), "7a2c9e41.md");
    // Waits inside the box for the file the next turn hands it, as a kept engine process would read it.
    const script = `echo started; for i in $(seq 1 200); do [ -f "${shown}" ] && exec cat "${shown}"; sleep 0.1; done; echo "never arrived"`;
    const wrapped = box.wrap({ command: "/bin/sh", args: ["-c", script], cwd: own, botId: "bot-a", conversationFolder, env: { ...ENV, HOME: home } })!;
    const child = spawn(wrapped.command, wrapped.args, { env: wrapped.env, stdio: ["ignore", "pipe", "pipe", ...wrapped.extraFds] });
    for (const fd of wrapped.extraFds) try { closeSync(fd); } catch {}
    let out = "";
    child.stdout?.on("data", (chunk) => { out += chunk; });
    child.stderr?.on("data", (chunk) => { out += chunk; });
    const exited = new Promise<void>((resolve) => child.once("close", () => { wrapped.release(); resolve(); }));
    await expect.poll(() => out, { timeout: 30_000 }).toBe("started\n");

    // The person's first attachment, handed to the next turn after the box started.
    const upload = join(uploads, "7a2c9e41.md");
    writeFileSync(upload, "room notes\n");
    expect(attachmentsForBox(`<attached-file path="${upload}" name="notes.md" />`, own, { botId: "bot-a", threadId: "room-1" }, true, dataDir, uploads)).toContain(shown);

    await exited;
    expect(out).toBe("started\nroom notes\n");
  }, 60_000);
});

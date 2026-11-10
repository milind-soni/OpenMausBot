// A file the person attached, read from inside a real box (Linux with an unprivileged bubblewrap, like a Cloud home).
// Elsewhere the suite says so and skips, like the box's own self-check.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { defaultCodeRoots } from "./bot-box/box.ts";
import { detectBox } from "./bot-box/detect.ts";
import { boxUploadsDir, bwrapArgs, planBox } from "./bot-box/plan.ts";
import { attachmentsForBox } from "./box-attachments.ts";

const detection = detectBox({ env: { ...process.env, OMB_BOT_BOX: "1" } });
const available = detection.box === "bwrap" && detection.tools !== null;
const root = mkdtempSync(join(tmpdir(), "omb-box-attach-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, "home"), dataDir = join(home, ".openmausbot"), uploads = join(dataDir, "attachments");
const cwd = join(dataDir, "task-workspaces", "bot-a", "t-1");
const env = { PATH: "/usr/bin:/bin", HOME: home };

/** What `cat` prints for the tag's path inside a box for this conversation, or null when it can't read it. */
function readInBox(tag: string): string | null {
  const path = /path="([^"]*)"/.exec(tag)![1]!;
  const run = runInBox(["/usr/bin/cat", path]);
  return run.status === 0 ? run.stdout : null;
}

function runInBox(argv: string[]): { status: number | null; stdout: string } {
  const plan = planBox({ dataDir, home, codeRoots: defaultCodeRoots(), engineRoots: [], bridges: [] }, { command: argv[0]!, args: [], cwd, env });
  return spawnSync(detection.tools!.bwrap, [...bwrapArgs(plan), "--", ...argv], { env, encoding: "utf8" });
}

describe.skipIf(!available)(`an attached file inside a real box (${available ? "bubblewrap works here" : `skipped: ${detection.reason}`})`, () => {
  it("is unreadable at its upload path, and readable but never writable at the path the engine is given", () => {
    mkdirSync(uploads, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(dataDir, "workspaces", "bot-a"), { recursive: true });
    const upload = join(uploads, "5c1e0d2a.md");
    writeFileSync(upload, "quarterly notes\n");
    const tag = `<attached-file path="${upload}" name="notes.md" />`;

    expect(readInBox(tag)).toBeNull();
    expect(readInBox(attachmentsForBox(tag, cwd, true, dataDir, uploads))).toBe("quarterly notes\n");
    // Read-only: the bot can neither change the upload nor swap the folder for a link.
    const shown = boxUploadsDir(dataDir, "bot-a", "t-1");
    expect(runInBox(["/usr/bin/sh", "-c", `echo x > ${join(shown, "5c1e0d2a.md")}`]).status).not.toBe(0);
    expect(runInBox(["/usr/bin/sh", "-c", `rm -rf ${shown} && ln -s /tmp ${shown}`]).status).not.toBe(0);
  });
});

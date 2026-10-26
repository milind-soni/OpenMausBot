// The engine homes in a real box, where one can run: Linux with an unprivileged bubblewrap (a Cloud home, the Fly test
// machine). Elsewhere the suite says so and skips, like the box's own self-check.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bwrapArgs, planBox, type BoxRequest } from "../bot-box/plan.ts";
import { detectBox } from "../bot-box/detect.ts";
import { audienceHome, engineHomesRoot, homedSpawn } from "./layout.ts";
import { syncSignIns } from "./sign-ins.ts";

const detection = detectBox({ env: { ...process.env, OMB_BOT_BOX: "1" } });
const available = detection.box === "bwrap" && detection.tools !== null;
const root = mkdtempSync(join(tmpdir(), "omb-engine-box-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const serverHome = join(root, "home"), dataDir = join(serverHome, ".openmausbot");
const owner = audienceHome(dataDir, "member:p_olive"), bob = audienceHome(dataDir, "member:p_bob");
const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const cwd = join(dataDir, "task-workspaces", "bot-a", "t-owner");

function runInBox(request: Omit<BoxRequest, "command" | "args" | "cwd">, script: string): string {
  const plan = planBox({ dataDir, home: serverHome, codeRoots: [], engineRoots: [], bridges: [] }, { command: "/bin/sh", args: [], cwd, ...request });
  const ran = spawnSync(detection.tools!.bwrap, [...bwrapArgs(plan), "--", "/bin/sh", "-c", script], {
    env: Object.fromEntries(Object.entries(request.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), encoding: "utf8", timeout: 30_000,
  });
  return `${ran.stdout}${ran.stderr}`;
}

describe.skipIf(!available)(`engine homes in a real box (${available ? "bubblewrap works here" : `skipped: ${detection.reason}`})`, () => {
  const homed = homedSpawn({ HOME: serverHome, PATH: "/usr/bin:/bin" }, { dataDir, serverHome, home: owner });
  beforeAll(() => {
    put(join(serverHome, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok-1" } }));
    put(join(serverHome, ".claude", "projects", "legacy", "0a1b2c3d-0000-4222-8333-444455556666.jsonl"), "the shared home's lighthouse");
    put(join(owner, ".claude", "projects", "p", "owner-session.jsonl"), "the owner's own");
    put(join(bob, ".claude", "projects", "p", "bob-session.jsonl"), "bob's secret is sardine");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(dataDir, "workspaces", "bot-a"), { recursive: true });
    syncSignIns(homed.shared);
  });
  const script = [
    'ls -R "$HOME/.claude/projects"',
    `cat "${join(bob, ".claude", "projects", "p", "bob-session.jsonl")}" || echo BOB-UNREADABLE`,
    `ls -a "${engineHomesRoot(dataDir)}"`,
    `grep -rl lighthouse "${serverHome}" 2>/dev/null || echo SHARED-HOME-UNREADABLE`,
    'cat "$HOME/.claude/.credentials.json"; echo',
    'printf x > "$HOME/.claude/.next" && mv "$HOME/.claude/.next" "$HOME/.claude/.credentials.json" 2>/dev/null || echo RENAME-REFUSED',
    `printf '%s' '{"claudeAiOauth":{"accessToken":"tok-refreshed"}}' > "$HOME/.claude/.credentials.json" && echo WROTE-IN-PLACE`,
  ].join("\n");

  it("a shell in the Owner's turn sees the Owner's home and the team's sign-in, never Bob's transcripts or the server's HOME", () => {
    const output = runInBox({ env: homed.env, home: homed.home, shared: homed.shared }, script);
    expect(output).toContain("owner-session.jsonl");
    expect(output).not.toContain("sardine");
    expect(output).toContain("BOB-UNREADABLE");
    expect(output).not.toContain(bob.slice(engineHomesRoot(dataDir).length + 1));
    expect(output).not.toContain("lighthouse");
    expect(output).toContain("SHARED-HOME-UNREADABLE");
    expect(output).toContain('"accessToken":"tok-1"');
    // Claude Code 2.1.294 renames a temp file over its credentials and writes in place where that is refused (EBUSY on a
    // bind), so a refresh made in the box lands in the team's file.
    expect(output).toContain("RENAME-REFUSED");
    expect(output).toContain("WROTE-IN-PLACE");
    expect(JSON.parse(readFileSync(join(serverHome, ".claude", ".credentials.json"), "utf8")).claudeAiOauth.accessToken).toBe("tok-refreshed");
  }, 60_000);

  it("without an engine home (the box as it was) the same shell reads the shared home's transcripts", () => {
    const output = runInBox({ env: { HOME: serverHome, PATH: "/usr/bin:/bin" } }, `grep -rl lighthouse "${serverHome}/.claude" || echo NONE`);
    expect(output).toContain("0a1b2c3d-0000-4222-8333-444455556666.jsonl");
  }, 60_000);
});

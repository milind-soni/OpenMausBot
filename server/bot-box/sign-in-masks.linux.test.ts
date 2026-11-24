// The sign-in masks in a real box, where one can run: Linux with an unprivileged bubblewrap (a Cloud home, the Fly test
// machine). Elsewhere the suite says so and skips, like the box's own self-check.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { detectBox } from "./detect.ts";
import { bwrapArgs, planBox, type BoxRequest } from "./plan.ts";
import { signInMasks } from "./sign-in-masks.ts";

const detection = detectBox({ env: { ...process.env, OMB_BOT_BOX: "1" } });
const available = detection.box === "bwrap" && detection.tools !== null;
const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-sign-in-box-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, "home"), dataDir = join(home, ".openmausbot");
const cwd = join(dataDir, "task-workspaces", "bot-a", "t-1");
const claude = join(home, ".claude", ".credentials.json"), codex = join(home, ".codex", "auth.json");
const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

function runInBox(engine: string, script: string): string {
  const request: BoxRequest = { command: "/bin/sh", args: [], cwd, env: { HOME: home, PATH: "/usr/bin:/bin" }, engine };
  const plan = planBox({ dataDir, home, codeRoots: [], engineRoots: [], bridges: [] }, request, signInMasks({ home, dataDir, env: request.env, engine }));
  const ran = spawnSync(detection.tools!.bwrap, [...bwrapArgs(plan), "--", "/bin/sh", "-c", script], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 30_000 });
  if (ran.error || ran.signal || ran.status !== 0) throw new Error(`the box did not run: ${ran.error?.message ?? ran.signal ?? ran.status}: ${ran.stderr}`);
  return `${ran.stdout}${ran.stderr}`;
}

describe.skipIf(!available)(`sign-in masks in a real box (${available ? "bubblewrap works here" : `skipped: ${detection.reason}`})`, () => {
  beforeAll(() => {
    put(claude, '{"claudeAiOauth":{"accessToken":"claude-secret"}}');
    put(codex, '{"tokens":{"access_token":"codex-1"}}');
    put(join(home, ".omb-edge", "caddy", "site.key"), "edge-secret");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(dataDir, "workspaces", "bot-a"), { recursive: true });
  });

  it("a Codex bot's shell reads and refreshes its own login, and never Claude's or the edge's keys", () => {
    const before = readdirSync(home).sort();
    const output = runInBox("codex", [
      `cat "${claude}"; echo " CLAUDE-END"`,
      `grep -r edge-secret "${home}/.omb-edge" 2>/dev/null || echo EDGE-UNREADABLE`,
      `printf x > "${claude}" 2>/dev/null || echo MASK-NOT-WRITABLE`,
      `mv "${claude}" "${home}/stolen" 2>/dev/null || echo MASK-NOT-MOVABLE`,
      `printf x > "${home}/.claude/.next" && mv "${home}/.claude/.next" "${claude}" 2>/dev/null || echo MASK-NOT-REPLACEABLE`,
      `cat "${codex}"; echo`,
      `mv "${home}/.codex/auth.json" "${home}/.codex/moved" 2>/dev/null || echo OWN-RENAME-REFUSED`,
      `printf '%s' '{"tokens":{"access_token":"codex-2"}}' > "${codex}" && echo WROTE-IN-PLACE`,
    ].join("\n"));
    expect(output).not.toContain("claude-secret");
    expect(output).toContain(" CLAUDE-END");
    expect(output).toContain("EDGE-UNREADABLE");
    expect(output).toContain("MASK-NOT-WRITABLE");
    expect(output).toContain("MASK-NOT-MOVABLE");
    expect(output).toContain("MASK-NOT-REPLACEABLE");
    expect(output).toContain("codex-1");
    expect(output).toContain("OWN-RENAME-REFUSED");
    expect(output).toContain("WROTE-IN-PLACE");
    expect(readFileSync(codex, "utf8")).toContain("codex-2");
    expect(readFileSync(claude, "utf8")).toContain("claude-secret");
    expect(readdirSync(home).sort()).toEqual(before);
  }, 60_000);

  it("a bot cannot rename a sign-in's folder away so the next box reads it at another path", () => {
    const first = runInBox("codex", [
      `mv "${home}/.claude" "${home}/moved-claude" 2>/dev/null || echo FOLDER-NOT-MOVABLE`,
      `rm -rf "${home}/.claude" 2>/dev/null; ls "${claude}" >/dev/null 2>&1 && echo STILL-THERE`,
    ].join("\n"));
    expect(first).toContain("FOLDER-NOT-MOVABLE");
    expect(first).toContain("STILL-THERE");
    const second = runInBox("codex", `cat "${home}/moved-claude/.credentials.json" 2>/dev/null || echo NOT-MOVED; cat "${claude}"; echo " END"`);
    expect(second).toContain("NOT-MOVED");
    expect(second).not.toContain("claude-secret");
    expect(readFileSync(claude, "utf8")).toContain("claude-secret");
  }, 60_000);

  it("leaves no empty sign-in file behind for an engine that never signed in here", () => {
    runInBox("claudeAgent", "true");
    expect(readdirSync(home)).not.toContain(".grok");
    expect(readdirSync(home)).not.toContain(".gemini");
  }, 60_000);
});

// A bot in the box can write the server's HOME (server/bot-box/plan.ts binds it read-write), so config planted there,
// ~/.claude/settings.json (apiKeyHelper, hooks) and ~/.codex/config.toml (a provider's auth command), must never run in
// the server's own engine reads, which run outside the box. The first part holds always; the second runs the real
// Claude Code and Codex CLIs against a planted, throwaway HOME (never the real one) when OMB_REAL_ENGINE_CHECKS=1 and
// both are on PATH, and its control shows the plain read would have run the planted command.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { whichOnPath } from "../bot-box/detect.ts";
import { backgroundCallArgs, backgroundIsolated, spawnBackgroundCall } from "./claude-background.ts";
import { readCodexAppServerModelCatalog } from "./codex-catalog.ts";
import { botBox } from "../bot-box/box.ts";
import { CODEX_OFFICIAL_READ_ARGS, codexAccountEmail, codexReadArgs } from "./codex-identity.ts";

describe("the server's own engine reads leave config planted in HOME out", () => {
  it("where the box is on, Codex's account and catalog reads name OpenAI's provider, so a planted provider is never active", () => {
    expect(CODEX_OFFICIAL_READ_ARGS).toEqual(["app-server", "-c", 'model_provider="openai"']);
    expect(codexReadArgs(true)).toEqual([...CODEX_OFFICIAL_READ_ARGS]);
    expect(codexReadArgs(false)).toEqual(["app-server"]);
  });

  it("a background Claude call is isolated wherever the box is on or required, even with the inherit switch", () => {
    expect(backgroundIsolated(true, true)).toBe(true);
    expect(backgroundIsolated(false, false)).toBe(true);
    expect(backgroundIsolated(true, false)).toBe(false);
    const args = backgroundCallArgs({ model: "haiku", outputFormat: "text", supports: () => true, isolated: backgroundIsolated(true, true) });
    expect(args).toEqual(expect.arrayContaining(["--setting-sources", "project", "--strict-mcp-config"]));
  });
});

const claude = whichOnPath("claude"), codex = whichOnPath("codex");
const real = process.env.OMB_REAL_ENGINE_CHECKS === "1" && claude !== null && codex !== null && process.platform !== "win32";
const root = mkdtempSync(join(tmpdir(), "omb-planted-home-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!real)("the real CLIs, with config planted in a throwaway HOME", () => {
  const home = join(root, "home"), marks = join(root, "marks");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(marks, { recursive: true });
  const touch = (name: string) => `touch ${join(marks, name)}`;
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    apiKeyHelper: `${touch("claude-api-key-helper")}; echo sk-planted`,
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: touch("claude-session-start") }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: touch("claude-prompt-submit") }] }],
    },
  }));
  writeFileSync(join(home, ".codex", "config.toml"), [
    'model_provider = "planted"',
    `notify = ["sh", "-c", ${JSON.stringify(touch("codex-notify"))}]`,
    "[mcp_servers.planted]", 'command = "sh"', `args = ["-c", ${JSON.stringify(touch("codex-mcp"))}]`,
    "[model_providers.planted]", 'name = "planted"', 'base_url = "http://127.0.0.1:9/v1"',
    "[model_providers.planted.auth]", 'command = "sh"', `args = ["-c", ${JSON.stringify(`${touch("codex-provider-auth")}; echo tok`)}]`,
  ].join("\n"));
  const env = { PATH: process.env.PATH, HOME: home, NO_COLOR: "1" } as NodeJS.ProcessEnv;
  const ran = () => readdirSync(marks);
  const ended = (child: ReturnType<typeof spawn>, ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, ms);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });

  it("control: a plain `codex app-server` that lists models runs the planted provider's command", async () => {
    const child = spawn(codex!, ["app-server"], { cwd: home, env, stdio: ["pipe", "pipe", "ignore"] });
    const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "openmausbot", version: "1" } } });
    setTimeout(() => { send({ method: "initialized", params: {} }); send({ id: 2, method: "model/list", params: {} }); }, 1_000);
    setTimeout(() => child.kill(), 8_000);
    await ended(child, 12_000);
    expect(existsSync(join(marks, "codex-provider-auth"))).toBe(true);
    rmSync(join(marks, "codex-provider-auth"), { force: true });
  }, 30_000);

  it("with the box on, Codex's catalog and account reads run none of it", async () => {
    const box = vi.spyOn(botBox, "enabled").mockReturnValue(true);
    try {
      await readCodexAppServerModelCatalog(codex!, env, 8_000);
      await codexAccountEmail(codex!, env, 8_000);
    } finally {
      box.mockRestore();
    }
    expect(ran()).toEqual([]);
  }, 30_000);

  it("Claude's sign-in check and an isolated background call run none of it", async () => {
    const status = spawn(claude!, ["auth", "status", "--json"], { cwd: home, env, stdio: ["ignore", "ignore", "ignore"] });
    await ended(status, 20_000);
    const args = backgroundCallArgs({ model: "haiku", outputFormat: "text", supports: () => true, isolated: backgroundIsolated(true, true) });
    const { child, removeCwd } = spawnBackgroundCall(claude!, [...args, "hi"], env);
    child.stdin.end();
    await ended(child, 30_000);
    removeCwd();
    expect(ran()).toEqual([]);
  }, 60_000);
});

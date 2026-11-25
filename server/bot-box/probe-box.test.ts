// The engine reads the server makes on its own (model lists, sign-in checks) load the engine's settings, extensions and
// MCP servers from HOME, which a boxed bot can write: each asks for the bot box, which runs it there where the box is on.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchDeepSeekCatalog } from "../drivers/acp/deepseek.ts";
import { fetchHermesAcpModels } from "../drivers/acp/hermes.ts";
import { discoverOpenCodeModels } from "../drivers/acp/opencode-go.ts";
import { fetchPiModels, updatePiModelCatalog } from "../drivers/pi.ts";
import { execCliBoxed } from "../procs.ts";
import { botBox } from "./box.ts";
import type { BoxRequest } from "./plan.ts";

const posix = process.platform !== "win32";

describe.skipIf(!posix)("the server's own engine reads ask for the bot box", () => {
  let dir: string;
  let asked: BoxRequest[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-probe-box-"));
    asked = [];
    // The box is off on this machine: wrap answers null and the spawn runs as is, but every request is seen.
    vi.spyOn(botBox, "wrap").mockImplementation((request) => { asked.push(request); return null; });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in CLI that answers nothing useful and exits. */
  function cli(name: string): string {
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
    return file;
  }

  const env = (extra: Record<string, string> = {}) => ({ PATH: "/usr/bin:/bin", HOME: dir, ...extra });

  it("Pi's model list and its catalog update", async () => {
    const pi = cli("pi");
    await fetchPiModels(pi, env({ NANO_KEY: "k" }), ["NANO_KEY"]);
    await updatePiModelCatalog(pi, env(), []);
    expect(asked.map((request) => [request.command, request.args[0], request.allowEnv])).toEqual([
      [pi, "--mode", ["NANO_KEY"]], [pi, "update", []],
    ]);
  });

  it("OpenCode's session probe and its models reads, with the instance's own keys", async () => {
    const opencode = cli("opencode");
    mkdirSync(join(dir, "data"), { recursive: true });
    await discoverOpenCodeModels(env({ VENICE_API_KEY: "v" }), opencode, { refresh: true, settleMs: 1, allowEnv: ["VENICE_API_KEY"] });
    const seen = asked.map((request) => request.args.join(" "));
    expect(seen).toEqual(expect.arrayContaining(["models --refresh", "acp", "models --verbose"]));
    for (const request of asked) expect(request.allowEnv).toEqual(["VENICE_API_KEY"]);
  });

  it("Hermes' and DeepSeek's catalogs", async () => {
    await fetchHermesAcpModels(cli("hermes"), env(), ["HERMES_KEY"]);
    await fetchDeepSeekCatalog(cli("dsh"), env(), dir, ["DEEPSEEK_API_KEY"]).catch(() => {});
    expect(asked.map((request) => [request.args.join(" "), request.allowEnv])).toEqual([["acp", ["HERMES_KEY"]], ["--profile acp", ["DEEPSEEK_API_KEY"]]]);
  });

  it("execCliBoxed answers as execCli does: output, a failing exit and a timeout", async () => {
    const script = join(dir, "say");
    writeFileSync(script, "#!/bin/sh\nif [ \"$1\" = fail ]; then echo no >&2; exit 3; fi\nif [ \"$1\" = hang ]; then sleep 30; fi\necho \"hello $1\"\n");
    chmodSync(script, 0o755);
    const run = (arg: string, timeout = 5_000) => new Promise<{ err: (Error & { code?: unknown; killed?: boolean }) | null; stdout: string; stderr: string }>((resolve) =>
      execCliBoxed(script, [arg], { env: env(), timeout, box: { allowEnv: [] } }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
    expect(await run("there")).toEqual({ err: null, stdout: "hello there\n", stderr: "" });
    const failed = await run("fail");
    expect(failed.err?.code).toBe(3);
    expect(failed.stderr).toBe("no\n");
    const hung = await run("hang", 200);
    expect(hung.err?.killed).toBe(true);
    expect(asked.every((request) => request.command === script)).toBe(true);
  });
});

import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { nativeFixture } from "../testing/antigravity-native-fixture.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { BRIDGE_CLI_ENV, TOOL_BRIDGE_ENV } from "./agents-bridge.ts";
import { antigravityProfileDirectory } from "./antigravity-acp.ts";
import { AntigravityDriver } from "./antigravity.ts";

const TESTING = join(dirname(fileURLToPath(import.meta.url)), "..", "testing");
const FAKE_MCP = join(TESTING, "fake-mcp-server.ts");
const FAKE_ACP = join(TESTING, "fake-acp-cli.ts");
const WINDOWS = process.platform === "win32";
const scratch: string[] = [];
const instances: ProviderInstance[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

const folder = () => { const made = mkdtempSync(join(tmpdir(), "omb-agy-restart-")); scratch.push(made); return made; };
const agentsServer = (env: Record<string, string>) => ({ command: process.execPath, args: [FAKE_MCP], env });

describe.skipIf(WINDOWS)("a native Antigravity session whose MCP servers change", () => {
  it("keeps its process for a new system prompt, and for new servers starts one after the old has exited, under the same names", async () => {
    const directory = folder();
    const fixture = nativeFixture(join(directory, "bin"));
    const instanceId = `agy-restart-${process.pid}`;
    const credential = join(antigravityProfileDirectory(instanceId), "antigravity-acp", "antigravity-oauth-token");
    mkdirSync(dirname(credential), { recursive: true });
    writeFileSync(credential, "{}");
    ensureDirs();
    const instance = await AntigravityDriver.create({
      instanceId, displayName: "Antigravity", enabled: true, config: { cli: fixture.executable, fullAuto: true },
      environment: { FAKE_AGY_LOG: fixture.log, FAKE_AGY_EXIT_DELAY_MS: "1500" },
    });
    instances.push(instance);
    const recorder = recordEvents(instance.adapter);
    let resumeCursor: string | undefined;
    const turn = async (system: string, env: Record<string, string>) => {
      const from = recorder.events.length;
      const { turnId } = await instance.adapter.sendTurn({ threadId: "restart", text: "fake-agy: tools", system, cwd: directory, resumeCursor, integrations: { agents: agentsServer(env) } });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 60_000);
      const started = recorder.events.slice(from).find((event) => event.type === "session.started") as { sessionId?: string } | undefined;
      resumeCursor = started?.sessionId ?? resumeCursor;
      return recorder.events.slice(from).flatMap((event) => event.type === "item.completed" ? [String((event as { text?: unknown }).text ?? "")] : []).join("");
    };
    const unbridged = { [TOOL_BRIDGE_ENV]: "0" };
    const bridged = { [TOOL_BRIDGE_ENV]: "1", [BRIDGE_CLI_ENV]: fixture.executable };
    // The turn's own sessions: the driver's model probe opens one with no servers.
    const sessionsOpened = () => {
      const entries = fixture.entries();
      return entries.filter((entry, index) => (entry.method === "session/new" || entry.method === "session/resume")
        && entries.slice(index + 1).find((next) => next.event === "tools" && next.pid === entry.pid)?.visible?.length > 0);
    };
    const pidOf = (entry: Record<string, unknown>) => entry.pid as number;

    expect(await turn("first prompt", unbridged)).toContain("TOOLS mcp_agents_read_notes");
    const first = sessionsOpened();
    expect(first.map((entry) => entry.method)).toEqual(["session/new"]);

    expect(await turn("second prompt", unbridged)).toContain("TOOLS mcp_agents_read_notes");
    expect(new Set(sessionsOpened().map(pidOf))).toEqual(new Set(first.map(pidOf)));

    expect(await turn("second prompt", bridged)).toMatch(/TOOLS mcp_agents_read_notes(?!_)/u);
    const afterSwitch = sessionsOpened();
    const resumed = afterSwitch[afterSwitch.length - 1]!;
    expect(resumed.method).toBe("session/resume");
    expect(pidOf(resumed)).not.toBe(pidOf(first[0]!));
    const entries = fixture.entries();
    const oldExited = entries.findIndex((entry) => entry.event === "exited" && entry.pid === pidOf(first[0]!));
    expect(oldExited).toBeGreaterThanOrEqual(0);
    expect(entries.findIndex((entry) => entry.event === "started" && entry.pid === pidOf(resumed))).toBeGreaterThan(oldExited);

    expect(await turn("second prompt", unbridged)).toMatch(/TOOLS mcp_agents_read_notes(?!_)/u);
    const back = sessionsOpened();
    expect(back[back.length - 1]).toMatchObject({ method: "session/resume" });
    expect(pidOf(back[back.length - 1]!)).not.toBe(pidOf(resumed));
  }, 120_000);
});

describe.skipIf(WINDOWS)("a pinned Antigravity runtime session whose MCP servers change", () => {
  it("keeps its process", async () => {
    const directory = folder();
    const executable = join(directory, "fake-antigravity.ts");
    const harness = join(directory, "localharness_external");
    copyFileSync(FAKE_ACP, executable);
    copyFileSync(FAKE_ACP, harness);
    chmodSync(executable, 0o755);
    chmodSync(harness, 0o755);
    const dump = join(directory, "dump.json");
    ensureDirs();
    const instanceId = `agy-pinned-${process.pid}`;
    const tokens = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokens, { recursive: true });
    writeFileSync(join(tokens, "acp_token.json"), "{}", { mode: 0o600 });
    const instance = await AntigravityDriver.create({
      instanceId, displayName: "Antigravity", enabled: true, config: { cli: executable, fullAuto: true },
      environment: { FAKE_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_DUMP: dump },
    });
    instances.push(instance);
    const recorder = recordEvents(instance.adapter);
    const pids: number[] = [];
    for (const marker of ["a", "b"]) {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "pinned", text: "hello", cwd: directory, integrations: { agents: agentsServer({ MARK: marker }) } });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 60_000);
      expect(existsSync(dump)).toBe(true);
      pids.push((JSON.parse(readFileSync(dump, "utf8")) as { pid: number }).pid);
    }
    expect(pids[1]).toBe(pids[0]);
  }, 120_000);
});

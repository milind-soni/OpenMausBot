import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs, instanceConfigs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import {
  classifyCopilotError, CopilotAgentDriver, copilotModelLabel, copilotSignedIn, forgetCopilotDiscoverySession, resolveCopilotModels,
} from "./copilot.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");
// The session opens on the first model, as Copilot CLI opens on the person's last terminal pick, not on Auto.
const MODELS = "claude-haiku-4.5,auto,gpt-5.6-luna";
const VARIANTS = JSON.stringify({
  "claude-haiku-4.5": { id: "reasoning_effort", currentValue: "medium", options: [{ value: "low", name: "low" }, { value: "medium", name: "medium" }] },
});
const NO_TOKENS = { COPILOT_GITHUB_TOKEN: "", GH_TOKEN: "", GITHUB_TOKEN: "" };
const PROBE_WAIT = 30_000;

describe("GitHub Copilot ACP driver", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "omb-copilot-contract-"));
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await removeTempDir(scratch);
  });

  async function create(environment: Record<string, string> = {}) {
    instance = await CopilotAgentDriver.create({
      instanceId: `copilot-contract-${Math.random().toString(36).slice(2)}`, displayName: "GitHub Copilot", enabled: true,
      environment: { FAKE_ACP_MODELS: MODELS, FAKE_ACP_VARIANTS: VARIANTS, FAKE_ACP_DUMP: join(scratch, "launch.json"), ...environment },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    return { instance, recorder };
  }

  const prompts = () => readFileSync(join(scratch, "launch.json.prompts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  /** Each probe is its own process; the fake appends one line per request with its pid. */
  const probe = (name: string, extra: Record<string, string> = {}) => {
    const rpc = join(scratch, `${name}.rpc.jsonl`);
    return {
      env: { ...process.env, ...NO_TOKENS, FAKE_ACP_MODELS: MODELS, FAKE_ACP_RPC_APPEND_FILE: rpc, COPILOT_HOME: join(scratch, name), ...extra },
      launches: () => existsSync(rpc) ? new Set(readFileSync(rpc, "utf8").trim().split("\n").map((line) => JSON.parse(line))
        .filter((entry) => entry.method === "initialize").map((entry) => entry.pid)).size : 0,
    };
  };

  it("is a built-in engine in fresh and existing fleets, beside a person's own custom Copilot instance", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "copilotAgent")).toBe(true);
    expect(instanceConfigs({}).githubCopilot?.driver).toBe("copilotAgent");
    const existing = instanceConfigs({ instances: {
      claude: { driver: "claudeAgent" },
      copilot: { driver: "customAcp", config: { cli: "copilot --acp --stdio" } },
    } });
    expect(existing.githubCopilot?.driver).toBe("copilotAgent");
    expect(existing.copilot?.driver).toBe("customAcp");
    expect(CopilotAgentDriver.metadata.access).toBe("subscription");
    expect(CopilotAgentDriver.models).toEqual({ default: "auto", options: [{ id: "auto", label: "Auto" }] });
  });

  it("lists the advertised models with Auto as the default and each model's own effort levels, without a prompt", async () => {
    const catalog = await resolveCopilotModels(probe("catalog", { FAKE_ACP_VARIANTS: VARIANTS }).env, { cli: FAKE_CLI });
    expect(catalog.default).toBe("auto");
    expect(catalog.options.map((option) => option.id)).toEqual(["claude-haiku-4.5", "auto", "gpt-5.6-luna"]);
    expect(catalog.options.some((option) => option.custom)).toBe(false);
    expect(catalog.options.find((option) => option.id === "claude-haiku-4.5")?.variants).toEqual([
      { id: "low", label: "low" }, { id: "medium", label: "medium" },
    ]);
  });

  it("labels a model with its premium request multiplier and ignores anything else in _meta", () => {
    const sessionNew = { configOptions: [{ id: "model", type: "select", category: "model", options: [
      { value: "claude-haiku-4.5", name: "Claude Haiku 4.5", _meta: { copilotUsage: "0.33x" } },
      { value: "odd", name: "Odd", _meta: { copilotUsage: "<b>free</b>" } },
      { value: "auto", name: "Auto", _meta: null },
    ] }] };
    expect(copilotModelLabel({ id: "claude-haiku-4.5", label: "Claude Haiku 4.5" }, sessionNew)).toBe("Claude Haiku 4.5 · 0.33x");
    expect(copilotModelLabel({ id: "odd", label: "Odd" }, sessionNew)).toBe("Odd");
    expect(copilotModelLabel({ id: "auto", label: "Auto" }, sessionNew)).toBe("Auto");
    expect(copilotModelLabel({ id: "auto", label: "Auto" }, null)).toBe("Auto");
  });

  it("tells a missing login apart from a reachable agent", async () => {
    const out = probe("signed-out", { FAKE_ACP_MODE: "auth-required" });
    expect(await copilotSignedIn(out.env, { cli: FAKE_CLI }, PROBE_WAIT)).toBe(false);
    expect(await copilotSignedIn(probe("signed-in").env, { cli: FAKE_CLI }, PROBE_WAIT)).toBe(true);
    // Only a refusal that names the login proves it missing; the turn reports anything else.
    expect(await copilotSignedIn(probe("unreachable").env, { cli: join(scratch, "missing-copilot") }, PROBE_WAIT)).toBe(true);
    const failure = join(scratch, "session-new-error.json");
    writeFileSync(failure, JSON.stringify({ code: -32000, message: "session already active in this agent" }));
    const busy = probe("busy", { FAKE_ACP_RPC_FAILURE_METHOD: "session/new", FAKE_ACP_RPC_FAILURE_FILE: failure });
    expect(await copilotSignedIn(busy.env, { cli: FAKE_CLI }, PROBE_WAIT)).toBe(true);
    expect(busy.launches()).toBe(1);
  });

  it("asks the CLI about a token in the environment too, and again once the token changes", async () => {
    const expired = probe("token", { FAKE_ACP_MODE: "auth-required", COPILOT_GITHUB_TOKEN: "expired-fixture-token" });
    expect(await copilotSignedIn(expired.env, { cli: FAKE_CLI }, PROBE_WAIT)).toBe(false);
    expect(expired.launches()).toBe(1);
    const renewed = { ...expired.env, FAKE_ACP_MODE: "happy", COPILOT_GITHUB_TOKEN: "renewed-fixture-token" };
    expect(await copilotSignedIn(renewed, { cli: FAKE_CLI }, PROBE_WAIT)).toBe(true);
    expect(expired.launches()).toBe(2);
  });

  it("keys the sign-in answer on the Copilot home the CLI would use, HOME included", async () => {
    const { COPILOT_HOME: _unset, ...base } = probe("by-home", { FAKE_ACP_MODE: "auth-required" }).env;
    const homeVar = process.platform === "win32" ? "USERPROFILE" : "HOME";
    const first = { ...base, [homeVar]: join(scratch, "home-a") };
    expect(await copilotSignedIn(first, { cli: FAKE_CLI }, PROBE_WAIT)).toBe(false);
    const second = { ...base, FAKE_ACP_MODE: "happy", [homeVar]: join(scratch, "home-b") };
    expect(await copilotSignedIn(second, { cli: FAKE_CLI }, PROBE_WAIT)).toBe(true);
  });

  it("starts one probe for concurrent and repeated checks, and none after a catalog refresh", async () => {
    const shared = probe("shared");
    const answers = await Promise.all([1, 2, 3].map(() => copilotSignedIn(shared.env, { cli: FAKE_CLI }, PROBE_WAIT)));
    expect(answers).toEqual([true, true, true]);
    expect(await copilotSignedIn(shared.env, { cli: FAKE_CLI }, PROBE_WAIT)).toBe(true);
    expect(shared.launches()).toBe(1);
    const refreshed = probe("refreshed");
    await resolveCopilotModels(refreshed.env, { cli: FAKE_CLI });
    expect(await copilotSignedIn(refreshed.env, { cli: FAKE_CLI }, PROBE_WAIT)).toBe(true);
    expect(refreshed.launches()).toBe(1);
  });

  it("checks a missing login again after a minute, not on every snapshot", async () => {
    const out = probe("expiring", { FAKE_ACP_MODE: "auth-required" });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    expect(await copilotSignedIn(out.env, { cli: FAKE_CLI }, PROBE_WAIT)).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    clock.mockReturnValue(now + 30_000);
    expect(await copilotSignedIn(out.env, { cli: FAKE_CLI }, PROBE_WAIT)).toBe(false);
    expect(out.launches()).toBe(1);
    clock.mockReturnValue(now + 61_000);
    expect(await copilotSignedIn(out.env, { cli: FAKE_CLI }, PROBE_WAIT)).toBe(false);
    expect(out.launches()).toBe(2);
  });

  it("keeps a failure that says nothing about the login for seconds, not minutes", async () => {
    const failure = join(scratch, "unproven-error.json");
    writeFileSync(failure, JSON.stringify({ code: -32603, message: "internal error" }));
    const flaky = probe("unproven", { FAKE_ACP_RPC_FAILURE_METHOD: "session/new", FAKE_ACP_RPC_FAILURE_FILE: failure });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    expect(await copilotSignedIn(flaky.env, { cli: FAKE_CLI }, PROBE_WAIT)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    clock.mockReturnValue(now + 10_000);
    expect(await copilotSignedIn(flaky.env, { cli: FAKE_CLI }, PROBE_WAIT)).toBe(true);
    expect(flaky.launches()).toBe(1);
    clock.mockReturnValue(now + 16_000);
    expect(await copilotSignedIn(flaky.env, { cli: FAKE_CLI }, PROBE_WAIT)).toBe(true);
    expect(flaky.launches()).toBe(2);
  });

  it("answers within the wait from the last probe while a hung one runs on, and offers the engine before any answer", async () => {
    const slow = probe("slow", { FAKE_ACP_MODE: "auth-required" });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    expect(await copilotSignedIn(slow.env, { cli: FAKE_CLI }, PROBE_WAIT)).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    clock.mockReturnValue(now + 61_000);
    // The next probe never gets past initialize, as with a `copilot` on PATH that does not speak ACP.
    const hung = { ...slow.env, FAKE_ACP_MODE: "hang-initialize" };
    expect(await copilotSignedIn(hung, { cli: FAKE_CLI }, 50)).toBe(false);
    expect(await copilotSignedIn(hung, { cli: FAKE_CLI }, 50)).toBe(false);
    const never = probe("never-answered", { FAKE_ACP_MODE: "hang-initialize" });
    expect(await copilotSignedIn(never.env, { cli: FAKE_CLI }, 50)).toBe(true);
    await Promise.all([copilotSignedIn(hung, { cli: FAKE_CLI }, PROBE_WAIT), copilotSignedIn(never.env, { cli: FAKE_CLI }, PROBE_WAIT)]);
    expect([slow.launches(), never.launches()]).toEqual([2, 1]);
  }, 60_000);

  it("starts nothing when the instance is created, so a `copilot` on PATH costs no launch", async () => {
    await create();
    expect(existsSync(join(scratch, "launch.json"))).toBe(false);
    expect(instance!.models.default).toBe("auto");
  });

  it("removes only the session folder the discovery itself left behind", async () => {
    const home = join(scratch, "copilot-home");
    // The fields and their plain-scalar style are Copilot CLI 1.0.105's own workspace.yaml.
    const session = (id: string, cwd: string, client = "openmausbot-model-discovery") => {
      mkdirSync(join(home, "session-state", id, "checkpoints"), { recursive: true });
      writeFileSync(join(home, "session-state", id, "workspace.yaml"), `id: ${id}\ncwd: ${cwd}\nclient_name: ${client}\nuser_named: false\n`
        + "summary_count: 0\nfork_count: 0\ncreated_at: 2026-10-28T01:45:38.058Z\nupdated_at: 2026-10-28T01:45:38.116Z\n");
      return join(home, "session-state", id);
    };
    const env = { COPILOT_HOME: home };
    const ours = session("ours", join(scratch, "omb-acp-models-x"));
    await forgetCopilotDiscoverySession({ sessionId: "ours", cwd: join(scratch, "omb-acp-models-x"), env });
    expect(existsSync(ours)).toBe(false);
    // A quoted value, a trailing separator or (on Windows) another case still names the same folder.
    const quoted = session("quoted", JSON.stringify(join(scratch, "omb-acp-models-y")));
    await forgetCopilotDiscoverySession({ sessionId: "quoted", cwd: join(scratch, "omb-acp-models-y"), env });
    const spelled = session("spelled", `${process.platform === "win32" ? join(scratch, "OMB-ACP-MODELS-Z") : join(scratch, "omb-acp-models-z")}${sep}`);
    await forgetCopilotDiscoverySession({ sessionId: "spelled", cwd: join(scratch, "omb-acp-models-z"), env });
    expect([existsSync(quoted), existsSync(spelled)]).toEqual([false, false]);
    const person = session("person", join(scratch, "project"), "copilot-cli");
    await forgetCopilotDiscoverySession({ sessionId: "person", cwd: join(scratch, "project"), env });
    const elsewhere = session("elsewhere", join(scratch, "other"));
    await forgetCopilotDiscoverySession({ sessionId: "elsewhere", cwd: join(scratch, "omb-acp-models-x"), env });
    await forgetCopilotDiscoverySession({ sessionId: "../copilot-home", cwd: join(scratch, "omb-acp-models-x"), env });
    expect([existsSync(person), existsSync(elsewhere), existsSync(home)]).toEqual([true, true, true]);
  });

  it("reads -32000 as a missing login only when the agent says so", () => {
    expect(classifyCopilotError({ code: -32000, message: "Authentication required" })).toBe("invalid_credentials");
    expect(classifyCopilotError({ code: -32000, message: "Not logged in" })).toBe("invalid_credentials");
    expect(classifyCopilotError({ code: -32000, message: "session already active in this agent" })).toBeUndefined();
    expect(classifyCopilotError({ code: -32603, message: "auth service unavailable" })).toBeUndefined();
    expect(classifyCopilotError({ code: -32000, message: "Invalid token" })).toBe("invalid_credentials");
    expect(classifyCopilotError({ code: -32000, message: "Not signed in. Run `copilot login`." })).toBe("invalid_credentials");
    for (const message of ["Your GitHub token has expired", "Token expired", "GitHub token is invalid", "Unauthorized", "authentication failed", "Bad credentials"]) {
      expect(classifyCopilotError({ code: -32000, message }), message).toBe("invalid_credentials");
    }
    for (const message of [
      "prompt exceeds the max tokens for this model", "context window token limit reached", "commit author unknown", "tool not authorized by policy",
      // Another server's credentials, not the Copilot login.
      "No token provided for MCP server github", "missing credentials for MCP server foo", "no authentication method configured for MCP server",
      "MCP server returned 401 Unauthorized", "no auth", "missing credentials",
    ]) {
      expect(classifyCopilotError({ code: -32000, message }), message).toBeUndefined();
    }
  });

  it("runs the picked model through ACP, never argv, and keeps the broker in charge of permissions", async () => {
    vi.stubEnv("COPILOT_ALLOW_ALL", "true");
    vi.stubEnv("GITHUB_TOKEN", "server-wide-fixture-token");
    const { instance, recorder } = await create({ GH_TOKEN: "engine-fixture-token", copilot_allow_all: "true" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "copilot-chat", text: "hello", model: "claude-haiku-4.5", approvalMode: "ask" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(recorder.events.every((event) => event.provider === "copilotAgent")).toBe(true);
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.argv).toEqual(["--acp", "--stdio"]);
    expect(launch.env.COPILOT_ALLOW_ALL).toBeUndefined();
    expect(launch.env.GITHUB_TOKEN).toBeUndefined();
    expect(launch.env.GH_TOKEN).toBe("engine-fixture-token");
    expect(prompts().at(-1)).toMatchObject({ model: "claude-haiku-4.5" });
  });

  it("turns Copilot's session/request_permission into an approval card and answers with the person's choice", async () => {
    const answer = join(scratch, "permission.txt");
    const { instance, recorder } = await create({ FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_ANSWER: answer });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "copilot-permission", text: "edit", model: "auto", approvalMode: "ask" });
    const ask = await recorder.until((event) => event.type === "request.opened");
    expect(ask.provider).toBe("copilotAgent");
    expect(await instance.adapter.respondToRequest("copilot-permission", ask.requestId!, { behavior: "deny" })).toBe("rejected");
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(readFileSync(answer, "utf8")).toBe("reject");
  });

  it("switches models between turns of one conversation", async () => {
    const { instance, recorder } = await create();
    for (const model of ["gpt-5.6-luna", "claude-haiku-4.5"]) {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "copilot-switch", text: `on ${model}`, model, approvalMode: "ask" });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    }
    expect(prompts().map((entry) => entry.model)).toEqual(["gpt-5.6-luna", "claude-haiku-4.5"]);
  });

  it("falls back to Auto, with a notice, when the plan no longer offers the saved model", async () => {
    const { instance, recorder } = await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "copilot-gone", text: "hello", model: "retired-model", approvalMode: "ask" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(prompts().at(-1)).toMatchObject({ model: "auto" });
    expect(recorder.events.some((event) => event.type === "runtime.notice" && /no longer offers retired-model/.test(String((event as { message?: unknown }).message)))).toBe(true);
  });

  it("reports a missing login as a sign-in step, not a raw RPC error", async () => {
    const { instance, recorder } = await create({ FAKE_ACP_MODE: "auth-required" });
    await instance.adapter.sendTurn({ threadId: "copilot-signed-out", text: "hello", model: "auto", approvalMode: "ask" }).catch(() => undefined);
    const error = await recorder.until((event) => event.type === "runtime.error");
    expect(String((error as { message?: unknown }).message)).toContain("copilot login");
    expect(existsSync(join(scratch, "launch.json.prompts.jsonl"))).toBe(false);
  });
});

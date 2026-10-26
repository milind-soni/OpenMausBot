import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../contracts.ts";
import { engineHomes } from "../engine-homes/engine-homes.ts";
import { audienceHome } from "../engine-homes/layout.ts";
import * as procs from "../procs.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import {
  MuseCodeDriver, museApprovalMode, museCatalog, museChoice, museModelLabel, museQuestions, museServeArgs,
  museToolOutput, museToolStart,
} from "./muse-code.ts";

const choices = [
  { choiceId: "c-once", label: "Allow once", decision: "approved", scope: "once" },
  { choiceId: "c-session", label: "Allow for this session", decision: "approvedForSession", scope: "session" },
  { choiceId: "c-abort", label: "Reject", decision: "abort", scope: "once" },
];

describe("Muse Code driver", () => {
  it("installs with Meta's installer, signs in with `muse login`, and starts on Muse Wonder", () => {
    expect(MuseCodeDriver.install?.command?.darwin).toBe("curl -fsSL https://dev.meta.ai/install.sh | bash");
    expect(MuseCodeDriver.install?.signInCommand).toBe("muse login");
    expect(MuseCodeDriver.defaultConfig()).toEqual({ cli: "muse" });
    expect(MuseCodeDriver.models.default).toBe("muse-wonder-1.0");
  });

  it("builds the picker from the account's own model list", () => {
    // Muse Code 1.4.9 without a sessionId: isActive marks a session's model, so it is false on every row.
    const listed = museCatalog({ models: [
      { modelId: "muse-wonder-1.0", displayLabel: "muse-wonder-1.0", isDefault: true, isActive: false, contextLimit: null },
      { modelId: "muse-wonder-full-1.0", displayLabel: "muse-wonder-full-1.0", isDefault: false, isActive: false },
      { modelId: "muse-spark-1.3", displayLabel: "Muse Spark 1.3", isActive: false, contextLimit: 500_000 },
      { modelId: "muse-spark-1.3" }, { modelId: 7 }, null,
    ] });
    expect(listed).toEqual({ default: "muse-wonder-1.0", options: [
      { id: "muse-wonder-1.0", label: "Muse Wonder 1.0", contextWindow: 1_048_576 },
      { id: "muse-wonder-full-1.0", label: "Muse Wonder Full 1.0", contextWindow: 1_048_576 },
      { id: "muse-spark-1.3", label: "Muse Spark 1.3", contextWindow: 500_000 },
    ] });
    expect(museCatalog({ models: [{ modelId: "muse-spark-1.3" }] }, "muse-next")?.default).toBe("muse-next");
    expect(museCatalog({ models: [] })).toBeNull();
    expect(museCatalog(null)).toBeNull();
    expect(museModelLabel("muse-spark-1.3-contributor")).toBe("Muse Spark 1.3 Contributor");
  });

  it("runs Full without asking or sandbox, and lets Muse ask on every other level", () => {
    expect(museApprovalMode("full")).toBe("allowAll");
    expect(museServeArgs("full")).toEqual(["serve", "--trust-workspace", "--disable-sandbox"]);
    for (const mode of ["ask", "auto", undefined] as const) {
      expect(museApprovalMode(mode)).toBe("promptUnmatched");
      expect(museServeArgs(mode)).toEqual(["serve", "--trust-workspace"]);
    }
  });

  it("answers an approval with the narrowest matching native choice", () => {
    expect(museChoice(choices, "allow")?.choiceId).toBe("c-once");
    expect(museChoice(choices, "allow", true)?.choiceId).toBe("c-session");
    // A shell ask offers no deny, only Reject.
    expect(museChoice(choices, "deny")?.choiceId).toBe("c-abort");
    expect(museChoice([...choices, { choiceId: "c-deny", label: "Deny", decision: "denied", scope: "once" }], "deny")?.choiceId).toBe("c-deny");
    expect(museChoice(choices.slice(2), "allow")).toBeUndefined();
  });

  it("shows a shell call as its command and reports its exit", () => {
    const item = { itemId: "i1", kind: "toolCall", status: "completed", tool: "bash", args: JSON.stringify({ command: "echo hi\nls" }), visibleOutput: "hi", exitCode: 0 };
    expect(museToolStart(item)).toMatchObject({ title: "bash", summary: "echo hi ls" });
    expect(museToolOutput(item)).toEqual({ ok: true, output: "hi" });
    expect(museToolOutput({ ...item, exitCode: 1 })).toMatchObject({ ok: false });
    expect(museToolOutput({ ...item, status: "failed", failureReason: "denied by policy", visibleOutput: undefined }))
      .toEqual({ ok: false, output: "denied by policy" });
    expect(museToolStart({ itemId: "i2", kind: "subagent", status: "inProgress", objective: "Review the diff" }).title).toBe("Review the diff");
  });

  it("turns Muse's questions into card questions keyed by Muse's ids", () => {
    const parsed = museQuestions([
      { id: "q1", header: "City", question: "Which city?", options: [{ label: "Pune" }, { label: "Mumbai" }], selection: { mode: "single" } },
      { id: "q2", header: "Days", question: "Which days?", options: [{ label: "Mon" }, { label: "Tue" }], selection: { mode: "multiple" } },
    ]);
    expect(parsed?.map(({ id, question }) => [id, question.question, question.multiSelect ?? false])).toEqual([
      ["q1", "Which city?", false], ["q2", "Which days?", true],
    ]);
    expect(museQuestions("nope")).toBeNull();
  });
});

const FAKE_MUSE_SERVE = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(process.env.FAKE_MUSE_LOG, JSON.stringify({ argv: process.argv.slice(2), home: process.env.HOME }) + "\\n");
const { FAKE_MUSE_TURN, FAKE_MUSE_INTERRUPT, FAKE_MUSE_EXIT_DELAY_MS } = process.env;
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\\n");
const input = createInterface({ input: process.stdin });
if (FAKE_MUSE_EXIT_DELAY_MS) input.on("close", () => setTimeout(() => process.exit(0), Number(FAKE_MUSE_EXIT_DELAY_MS)));
input.on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") return send({ id, result: { schema: { fingerprint: "sha256:fake" }, grantedCapabilities: [] } });
  if (method === "model/list") return send({ id, result: { models: [{ modelId: "muse-fake-1.0", isDefault: true }] } });
  if (method === "session/start") return send({ id, result: { session: { sessionId: "s-1", modelId: "muse-fake-1.0" } } });
  if (method === "turn/interrupt" && FAKE_MUSE_INTERRUPT === "refuse") {
    return send({ id, error: { code: -32000, message: "interrupt refused", data: { kind: "invalidState" } } });
  }
  send({ id, result: { commandId: params.commandId } });
  if (method !== "turn/start" || FAKE_MUSE_TURN === "hang") return;
  const { sessionId, commandId: turnId } = params;
  send({ method: "item/completed", params: { sessionId, item: { itemId: "m1", kind: "agentMessage", status: "completed", turnId, text: "hello" } } });
  send({ method: "turn/completed", params: { sessionId, turnId, terminal: "completed" } });
});
`;

describe.skipIf(process.platform === "win32")("Muse Code's process", () => {
  let root = "";
  afterEach(async () => {
    engineHomes.stop();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await removeTempDir(root);
  });

  const fakeMuse = () => {
    root = mkdtempSync(join(tmpdir(), "omb-muse-launch-"));
    const log = join(root, "launches.jsonl");
    writeFileSync(join(root, "fake-muse.mjs"), FAKE_MUSE_SERVE);
    const cli = join(root, "muse");
    writeFileSync(cli, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "fake-muse.mjs"))} "$@"\n`, { mode: 0o755 });
    vi.stubEnv("FAKE_MUSE_LOG", log);
    return { cli, log };
  };

  it("starts through the shared launcher, in the conversation's engine home, and stops with the instance", async () => {
    const { cli, log } = fakeMuse();
    const home = join(root, "home");
    const dataDir = join(home, ".openmausbot");
    mkdirSync(dataDir, { recursive: true });
    engineHomes.start({ dataDir, serverHome: home, audienceOf: () => "member:p_bob", threads: () => [], log: () => {} });
    const spawned = vi.spyOn(procs, "spawnCli");

    const instance = await MuseCodeDriver.create({ instanceId: "museCode", displayName: "Muse Code", enabled: true,
      environment: { HOME: home }, config: MuseCodeDriver.decodeConfig({ cli }) });
    let engine: ReturnType<typeof procs.spawnCli> | undefined;
    try {
      const completed = new Promise<RuntimeEvent>((resolve) => instance.adapter.onEvent((event) => {
        if (event.type === "turn.completed") resolve(event);
      }));
      await engineHomes.within("t-bob", () => instance.adapter.sendTurn({ threadId: "t-bob", text: "hi", cwd: root }));
      expect(await completed).toMatchObject({ ok: true });

      const bot = spawned.mock.calls.findIndex((call) => call[3] === "bot");
      expect(bot).toBeGreaterThanOrEqual(0);
      expect(spawned.mock.calls[bot]![1]).toEqual(["serve", "--trust-workspace"]);
      expect(spawned.mock.calls[bot]![2]).toMatchObject({ cwd: root, box: { allowEnv: ["HOME"] } });
      engine = spawned.mock.results[bot]!.value;
      const launches = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; home: string });
      expect(launches.find((launch) => launch.argv.includes("--trust-workspace"))?.home).toBe(audienceHome(dataDir, "member:p_bob"));
    } finally {
      await instance.dispose();
    }
    expect(engine!.exitCode !== null || engine!.signalCode !== null).toBe(true);
  }, 20_000);

  describe("Stop", () => {
    const runningTurn = async (interrupt: "ack" | "refuse") => {
      const { cli } = fakeMuse();
      vi.stubEnv("FAKE_MUSE_TURN", "hang");
      vi.stubEnv("FAKE_MUSE_INTERRUPT", interrupt);
      const spawned = vi.spyOn(procs, "spawnCli");
      const instance = await MuseCodeDriver.create({ instanceId: "museCode", displayName: "Muse Code", enabled: true,
        environment: {}, config: MuseCodeDriver.decodeConfig({ cli }) });
      const exited = () => {
        const bot = spawned.mock.calls.findIndex((call) => call[3] === "bot");
        const engine: ReturnType<typeof procs.spawnCli> = spawned.mock.results[bot]!.value;
        return engine.exitCode !== null || engine.signalCode !== null;
      };
      const settled: { started?: boolean; completed?: RuntimeEvent; hostExited?: boolean } = {};
      instance.adapter.onEvent((event) => {
        if (event.type === "turn.started") settled.started = true;
        if (event.type !== "turn.completed") return;
        settled.completed = event;
        settled.hostExited = exited();
      });
      await instance.adapter.sendTurn({ threadId: "t-stop", text: "work", cwd: root, approvalMode: "full" });
      await vi.waitFor(() => expect(settled.started).toBe(true));
      return { instance, settled, exited };
    };

    it("ends the host before it reports a turn stopped whose interrupt Muse refused", async () => {
      const { instance, settled } = await runningTurn("refuse");
      try {
        await instance.adapter.interruptTurn("t-stop");
        expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" });
        expect(settled.hostExited).toBe(true);
      } finally {
        await instance.dispose();
      }
    }, 20_000);

    it("waits for the same host shutdown when Stop is pressed again", async () => {
      vi.stubEnv("FAKE_MUSE_EXIT_DELAY_MS", "500");
      const { instance, settled, exited } = await runningTurn("refuse");
      try {
        const first = instance.adapter.interruptTurn("t-stop");
        await new Promise((resolve) => setTimeout(resolve, 50));
        await instance.adapter.interruptTurn("t-stop");
        expect(exited()).toBe(true);
        expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" });
        expect(settled.hostExited).toBe(true);
        await first;
      } finally {
        await instance.dispose();
      }
    }, 20_000);

    it("disposes only after a Stop's host shutdown ends", async () => {
      vi.stubEnv("FAKE_MUSE_EXIT_DELAY_MS", "500");
      const { instance, settled, exited } = await runningTurn("refuse");
      const stopped = instance.adapter.interruptTurn("t-stop");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await instance.dispose();
      expect(exited()).toBe(true);
      expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" });
      expect(settled.hostExited).toBe(true);
      await stopped;
    }, 20_000);

    it("ends the host when an acknowledged interrupt is never confirmed", async () => {
      const { instance, settled } = await runningTurn("ack");
      try {
        await instance.adapter.interruptTurn("t-stop");
        expect(settled.completed).toBeUndefined();
        await vi.waitFor(() => expect(settled.completed).toMatchObject({ ok: false, stopReason: "interrupted" }), { timeout: 8_000 });
        expect(settled.hostExited).toBe(true);
      } finally {
        await instance.dispose();
      }
    }, 20_000);
  });
});

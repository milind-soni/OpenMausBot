// Steering a running Grok turn with a second session/prompt, against the scripted ACP peer.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { AnyProviderDriver, ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { ensureGrokSteer, GROK_STEER, GrokAgentDriver } from "./grok.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");

let scratch: string;
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;

beforeEach(() => {
  ensureDirs();
  scratch = mkdtempSync(join(tmpdir(), "omb-grok-steer-"));
});

afterEach(async () => {
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  recorder = undefined;
  await removeTempDir(scratch);
});

const configure = (steer: boolean) => {
  mkdirSync(join(scratch, "grok"), { recursive: true });
  writeFileSync(join(scratch, "grok", "auth.json"), "{}");
  writeFileSync(join(scratch, "grok", "config.toml"), `[ui]
follow_up_behavior = "${steer ? "steer" : "queue"}"
`);
};

const gate = () => join(scratch, "finish.gate");

const start = async (driver: AnyProviderDriver, mode: string, extra: Record<string, string> = {}) => {
  instance = await driver.create({
    instanceId: `steer-${driver.driverKind}`,
    displayName: "Steer fixture",
    enabled: true,
    environment: {
      HOME: scratch,
      USERPROFILE: scratch,
      XDG_DATA_HOME: join(scratch, "data"),
      GROK_HOME: join(scratch, "grok"),
      OPENMAUSBOT_PROBE_LOCAL_INJECT: "0",
      FAKE_ACP_MODELS: "swe-1-6-fast,claude-sonnet-5-5",
      FAKE_ACP_MODES: "accept-edits,smart,ask,plan,bypass",
      FAKE_ACP_MODE: mode,
      FAKE_ACP_GATE_FILE: gate(),
      FAKE_ACP_RPC_APPEND_FILE: join(scratch, "rpc.jsonl"),
      ...extra,
    },
    config: { cli: FAKE_CLI, fullAuto: true },
  } as never) as ProviderInstance;
  recorder = recordEvents(instance.adapter);
  return instance;
};

const threadId = "steer-thread";

const runningTurn = async () => {
  const { turnId } = await instance!.adapter.sendTurn({ threadId, text: "Build the report.", cwd: scratch });
  await recorder!.until((event) => event.turnId === turnId && event.type === "content.delta" && event.delta.includes("working"));
  return turnId;
};

const finished = async (turnId: string) => {
  writeFileSync(gate(), "finish");
  return recorder!.until((event) => event.turnId === turnId && event.type === "turn.completed");
};

const replyOf = (turnId: string) => recorder!.events
  .flatMap((event) => event.turnId === turnId && event.type === "item.completed" && event.itemType === "assistant_text" ? [event.text] : []);

const usageOf = (turnId: string) => recorder!.events
  .flatMap((event) => event.turnId === turnId && event.type === "thread.token-usage.updated" ? [[event.input, event.output]] : []);

const until = async (done: () => boolean) => {
  for (let tries = 0; !done(); tries += 1) {
    if (tries > 200) throw new Error("the agent never received the steer");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const methods = () => existsSync(join(scratch, "rpc.jsonl"))
  ? readFileSync(join(scratch, "rpc.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line).method as string)
  : [];

describe("Grok steering", () => {
  it("steers a message into the running turn as a second prompt and ends with the turn's own reply", async () => {
    configure(true);
    await start(GrokAgentDriver, "grok-steer");
    const turnId = await runningTurn();

    expect(await instance!.adapter.steer!(threadId, "  Use pytest.  ")).toBe("steered");
    await until(() => methods().includes("session/prompt.steer"));

    expect(await finished(turnId)).toMatchObject({ ok: true });
    expect(replyOf(turnId)).toEqual(["working. done; steered: Use pytest."]);
    expect(usageOf(turnId)).toEqual([[10, 5]]);
  });

  it("refuses without sending while Grok's follow-up behaviour is queue", async () => {
    configure(false);
    await start(GrokAgentDriver, "grok-steer");
    const turnId = await runningTurn();

    expect(await instance!.adapter.steer!(threadId, "use pytest")).toBe("refused");
    expect(methods()).not.toContain("session/prompt.steer");
    await finished(turnId);
    expect(replyOf(turnId)).toEqual(["working. done"]);
  });
});

describe("ensureGrokSteer", () => {
  const home = () => join(scratch, "grok");
  const config = () => join(home(), "config.toml");
  const env = () => ({ GROK_HOME: home() });
  const signedIn = () => { mkdirSync(home(), { recursive: true }); writeFileSync(join(home(), "auth.json"), "{}"); };

  it("adds a [ui] section to a config without one", () => {
    signedIn();
    writeFileSync(config(), '[cli]\ninstaller = "internal"\n');
    ensureGrokSteer(env());
    expect(readFileSync(config(), "utf8")).toBe('[cli]\ninstaller = "internal"\n\n[ui]\nfollow_up_behavior = "steer"\n');
  });

  it("adds the key under an existing [ui]", () => {
    signedIn();
    writeFileSync(config(), '[ui]\nscreen_mode = "minimal"\n');
    ensureGrokSteer(env());
    expect(readFileSync(config(), "utf8")).toBe('[ui]\nfollow_up_behavior = "steer"\nscreen_mode = "minimal"\n');
  });

  it("creates the config for a signed-in account that has none", () => {
    signedIn();
    ensureGrokSteer(env());
    expect(readFileSync(config(), "utf8")).toBe('[ui]\nfollow_up_behavior = "steer"\n');
  });

  it("keeps a choice the person already made", () => {
    signedIn();
    writeFileSync(config(), '[ui]\nfollow_up_behavior = "queue"\n');
    ensureGrokSteer(env());
    expect(readFileSync(config(), "utf8")).toBe('[ui]\nfollow_up_behavior = "queue"\n');
  });

  it("leaves a signed-out home alone", () => {
    ensureGrokSteer(env());
    expect(existsSync(home())).toBe(false);
  });

  it("keeps a choice written with a quoted key or a single-quoted value", () => {
    signedIn();
    for (const text of ['[ui]\n"follow_up_behavior" = "queue"\n', "[ui]\nfollow_up_behavior = 'steer'\n"]) {
      writeFileSync(config(), text);
      ensureGrokSteer(env());
      expect(readFileSync(config(), "utf8")).toBe(text);
    }
  });

  it("adds the key under a [ui] header that has a comment, or that ends the file without a newline", () => {
    signedIn();
    writeFileSync(config(), '[ui] # display settings\nscreen_mode = "minimal"\n');
    ensureGrokSteer(env());
    expect(readFileSync(config(), "utf8")).toBe('[ui] # display settings\nfollow_up_behavior = "steer"\nscreen_mode = "minimal"\n');

    writeFileSync(config(), "[ui]");
    ensureGrokSteer(env());
    expect(readFileSync(config(), "utf8")).toBe('[ui]\nfollow_up_behavior = "steer"\n');
  });

  it("writes nothing when ui is defined another way, or the file cannot be read with confidence", () => {
    signedIn();
    for (const text of ['ui.screen_mode = "minimal"\n', 'ui = { screen_mode = "minimal" }\n', 'note = """\n[ui]\n"""\n', "ui = []\n", "[[ui]]\nx = 1\n"]) {
      writeFileSync(config(), text);
      ensureGrokSteer(env());
      expect(readFileSync(config(), "utf8"), text).toBe(text);
    }
  });

  it("reads a single-quoted steer, and leaves no temporary file behind", () => {
    signedIn();
    writeFileSync(config(), "[ui]\nfollow_up_behavior = 'steer'\n");
    expect(GROK_STEER.enabled!(env())).toBe(true);
    writeFileSync(config(), '[other]\nfollow_up_behavior = "steer"\n');
    expect(GROK_STEER.enabled!(env())).toBe(false);
    ensureGrokSteer(env());
    expect(readFileSync(config(), "utf8")).toBe('[other]\nfollow_up_behavior = "steer"\n\n[ui]\nfollow_up_behavior = "steer"\n');
    expect(readdirSync(home()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

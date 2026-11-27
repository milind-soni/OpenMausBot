import { chmodSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ModelCatalog, ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { addServerLinePacks, setConversationLanguage } from "../server-lines.ts";
import { claudeAccountFiles, createOrgModelBlocks, modelSwapNotice, otherModelAnswered, parseOrgBlockedModels, withOrgBlocks } from "./claude-model-access.ts";
import { ClaudeDriver } from "./claude.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
const scratch: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-model-access-"));
  scratch.push(dir);
  return dir;
};
const access = (...entries: unknown[]) => JSON.stringify({ projects: { "/a": { history: ["]{"] } }, modelAccessCache: entries, numStartups: 3 });

const catalog: ModelCatalog = {
  default: "claude-sonnet-5",
  options: [
    { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  ],
};

afterEach(async () => {
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
  setConversationLanguage(() => undefined);
  addServerLinePacks({ de: {} });
  vi.unstubAllEnvs();
});

describe("what the organization turned off", () => {
  it("names only the models the cache explicitly denies, as catalog ids", () => {
    const blocked = parseOrgBlockedModels(access(
      { apiName: "claude-fable-5-1", entitled: false },
      { apiName: "claude-opus-5-5", entitled: true },
      { apiName: "claude-haiku-4-5-20251001", entitled: false },
      { apiName: "Claude-Sonnet-5[1m]", entitled: false },
      { apiName: "claude-opus-5", entitled: "false" },
      { apiName: "claude-opus-4" },
      { entitled: false },
      null,
    ));
    expect([...blocked]).toEqual(["claude-fable-5-1", "claude-haiku-4-5", "claude-sonnet-5"]);
  });

  it.each([
    ["malformed JSON", "{"],
    ["no cache", '{"oauthAccount":{}}'],
    ["a cache that is not a list", '{"modelAccessCache":{"claude-fable-5-1":false}}'],
    ["nothing", ""],
  ])("hides nothing for %s", (_, text) => {
    expect(parseOrgBlockedModels(text).size).toBe(0);
  });

  it("marks a blocked model and moves a blocked default to one the organization allows", () => {
    const marked = withOrgBlocks(catalog, new Set(["claude-sonnet-5"]));
    expect(marked.options.find((option) => option.id === "claude-sonnet-5")?.orgBlocked).toBe(true);
    expect(marked.options.filter((option) => option.orgBlocked)).toHaveLength(1);
    expect(marked.default).toBe("claude-fable-5-1");
  });

  it("takes a mark back once the organization allows the model again, and never marks a local model", () => {
    const local = { ...catalog, options: [...catalog.options, { id: "claude-local", label: "Local", custom: true }] };
    const marked = withOrgBlocks(local, new Set(["claude-fable-5-1", "claude-local"]));
    expect(marked.options.map((option) => Boolean(option.orgBlocked))).toEqual([true, false, false, false]);
    expect(withOrgBlocks(marked, new Set()).options.some((option) => option.orgBlocked)).toBe(false);
  });
});

describe("reading the account config", () => {
  it("looks where the CLI keeps it", () => {
    expect(claudeAccountFiles({ HOME: "/h" })).toEqual([join("/h", ".claude", ".config.json"), join("/h", ".claude.json")]);
    expect(claudeAccountFiles({ HOME: "/h", CLAUDE_CONFIG_DIR: "/c" })).toEqual([join("/c", ".config.json"), join("/c", ".claude.json")]);
  });

  it("on Windows takes USERPROFILE as the home, as the CLI's os.homedir() does, not a HOME a shell left behind", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const shell = { HOME: "/c/shell-home", USERPROFILE: "/Users/ada" };
      expect(claudeAccountFiles(shell)).toEqual([join("/Users/ada", ".claude", ".config.json"), join("/Users/ada", ".claude.json")]);
      expect(claudeAccountFiles({ ...shell, CLAUDE_CONFIG_DIR: "/c" })).toEqual([join("/c", ".config.json"), join("/c", ".claude.json")]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("keeps what it knew when the file cannot be read for a moment, and reads it again next time", async () => {
    const home = tempDir();
    const file = join(home, ".claude.json");
    writeFileSync(file, access({ apiName: "claude-fable-5-1", entitled: false }));
    const seen: string[][] = [];
    const reads = [() => Promise.resolve(access({ apiName: "claude-fable-5-1", entitled: false })), () => Promise.reject(new Error("EPERM")), () => Promise.resolve(access())];
    const blocks = createOrgModelBlocks(() => [{ HOME: home, USERPROFILE: home }], (blocked) => seen.push([...blocked]), () => reads.shift()!());
    await blocks.refresh();
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    await blocks.refresh();
    expect(seen).toEqual([["claude-fable-5-1"]]);
    await blocks.refresh();
    expect(seen).toEqual([["claude-fable-5-1"], []]);
  });

  const watch = (env: Record<string, string | undefined>[]) => {
    const seen: string[][] = [];
    return { seen, blocks: createOrgModelBlocks(() => env, (blocked) => seen.push([...blocked])) };
  };

  it("reads again only when the file changed", async () => {
    const home = tempDir();
    const file = join(home, ".claude.json");
    writeFileSync(file, access({ apiName: "claude-fable-5-1", entitled: false }));
    const { seen, blocks } = watch([{ HOME: home, USERPROFILE: home }]);
    await blocks.refresh();
    await blocks.refresh();
    expect(seen).toEqual([["claude-fable-5-1"]]);
    writeFileSync(file, access());
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    await blocks.refresh();
    expect(seen.at(-1)).toEqual([]);
  });

  it("on a cloud provider's backend ignores a list an earlier sign-in left", async () => {
    const home = tempDir();
    writeFileSync(join(home, ".claude.json"), access({ apiName: "claude-fable-5-1", entitled: false }));
    const { seen, blocks } = watch([{ HOME: home, USERPROFILE: home, CLAUDE_CODE_USE_BEDROCK: "1" }]);
    await blocks.refresh();
    expect(seen).toEqual([[]]);
  });

  it("takes the newest answer among a Team Cloud's engine homes", async () => {
    const [older, newer] = [tempDir(), tempDir()];
    writeFileSync(join(older, ".claude.json"), access({ apiName: "claude-opus-5", entitled: false }));
    utimesSync(join(older, ".claude.json"), new Date(1_000), new Date(1_000));
    writeFileSync(join(newer, ".claude.json"), access({ apiName: "claude-fable-5", entitled: false }));
    const { seen, blocks } = watch([{ HOME: older, USERPROFILE: older }, { HOME: newer, USERPROFILE: newer }]);
    await blocks.refresh();
    expect(seen).toEqual([["claude-fable-5"]]);
  });
});

describe("a turn answered by another model", () => {
  it.each([
    ["claude-fable-5-1", "claude-opus-5-5", true],
    ["claude-opus-5-5", "claude-opus-5-5", false],
    ["claude-opus-5-5", "claude-opus-5-5[1m]", false],
    ["claude-haiku-4-5", "claude-haiku-4-5-20251001", false],
    ["claude-fable-5-1", "<synthetic>", false],
    ["sonnet", "claude-sonnet-5", false],
    ["ollama::qwen", "qwen", false],
    ["claude-opus-5-5", "us.anthropic.claude-opus-5-5-v1:0", false],
    [null, "claude-opus-5-5", false],
    ["claude-opus-5-5", undefined, false],
  ])("%s then %s: %s", (picked, answered, other) => {
    expect(otherModelAnswered(picked as string | null, answered)).toBe(other);
  });

  it("says the organization turned it off only when it did, by the models' names, once per session for each pair", () => {
    const blocked = withOrgBlocks(catalog, new Set(["claude-fable-5-1"]));
    const session = {};
    const by = (model: string) => ({ message: { model } });
    expect(modelSwapNotice(session, "t", "claude-fable-5-1", by("claude-opus-5-5-20260101"), blocked))
      .toBe("Claude Fable 5.1 is turned off by your organization, so Claude Opus 5.5 answered instead. Choose another model to stop seeing this.");
    expect(modelSwapNotice(session, "t", "claude-fable-5-1", by("claude-opus-5-5"), blocked)).toBeNull();
    expect(modelSwapNotice(session, "t", "claude-sonnet-5", by("claude-opus-5-5"), blocked)).toBe("You chose Claude Sonnet 5, but Claude Opus 5.5 answered instead.");
    expect(modelSwapNotice({}, "t", "claude-fable-5-1", by("claude-opus-5-5"), blocked)).toContain("turned off");
  });

  it("ignores a subagent's model", () => {
    expect(modelSwapNotice({}, "t", "claude-fable-5-1", { parent_tool_use_id: "toolu_1", message: { model: "claude-haiku-5-5" } }, catalog)).toBeNull();
  });

  it("speaks the conversation's language", () => {
    addServerLinePacks({ de: { "server.model.otherAnswered": "Gewählt: {picked}, geantwortet: {answered}." } });
    setConversationLanguage(() => "de");
    expect(modelSwapNotice({}, "t", "claude-sonnet-5", { message: { model: "claude-opus-5-5" } }, catalog)).toBe("Gewählt: Claude Sonnet 5, geantwortet: Claude Opus 5.5.");
  });
});

describe("the Claude driver", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = recorder = undefined;
  });

  const start = async (answeredBy: string | undefined, cache: unknown[]) => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const configDir = tempDir();
    writeFileSync(join(configDir, ".claude.json"), access(...cache));
    if (answeredBy) vi.stubEnv("FAKE_CLAUDE_ANSWER_MODEL", answeredBy);
    instance = await ClaudeDriver.create({
      instanceId: `claude-access-${Math.random().toString(36).slice(2, 10)}`,
      displayName: "Claude", environment: {}, enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits", configDir },
    });
    await instance.startupModelRefresh;
    await instance.refreshModels?.();
    recorder = recordEvents(instance.adapter);
    return { instance, recorder, configDir };
  };

  it("lists a model the account's organization turned off as blocked, and tells the person who answered instead", async () => {
    const { instance, recorder } = await start("claude-opus-5-5", [{ apiName: "claude-fable-5-1", entitled: false }]);
    expect(instance.models.options.find((option) => option.id === "claude-fable-5-1")?.orgBlocked).toBe(true);
    await instance.adapter.sendTurn({ threadId: "t-swap", text: "hi", model: "claude-fable-5-1" });
    await recorder.until((event) => event.type === "turn.completed");
    expect(recorder.events.filter((event) => event.type === "runtime.notice")).toEqual([
      expect.objectContaining({ message: expect.stringContaining("Claude Fable 5.1 is turned off by your organization") }),
    ]);
  });

  it("says nothing when the model picked is the model that answered", async () => {
    const { instance, recorder } = await start("claude-opus-5-5[1m]", []);
    await instance.adapter.sendTurn({ threadId: "t-same", text: "hi", model: "claude-opus-5-5" });
    await recorder.until((event) => event.type === "turn.completed");
    expect(recorder.events.filter((event) => event.type === "runtime.notice")).toEqual([]);
  });

  it("notices a block that arrives after the catalog was read, once a turn has ended", async () => {
    const { instance, recorder, configDir } = await start(undefined, []);
    expect(instance.models.options.some((option) => option.orgBlocked)).toBe(false);
    const file = join(configDir, ".claude.json");
    writeFileSync(file, access({ apiName: "claude-opus-5", entitled: false }));
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    await instance.adapter.sendTurn({ threadId: "t-later", text: "hi", model: "claude-sonnet-5" });
    await recorder.until((event) => event.type === "turn.completed");
    await vi.waitFor(() => expect(instance.models.options.find((option) => option.id === "claude-opus-5")?.orgBlocked).toBe(true));
  });
});

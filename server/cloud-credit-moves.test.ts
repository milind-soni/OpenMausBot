import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCreditMoves, type CreditMovesOptions } from "./cloud-credit-moves.ts";
import type { ModelSelection } from "./contracts.ts";
import type { SelectableInstance } from "./default-model-selection.ts";

const CREDIT = "trial-credit";
type Task = { threadId: string; modelSelection?: ModelSelection };
type Bot = { id: string; name: string; modelSelection: ModelSelection; tasks: Task[] };

const engine = (instanceId: string, driverKind: string, authenticated: boolean | undefined, models: string[], state: "available" | "unavailable" = "available"): SelectableInstance => ({
  instanceId, driverKind, snapshot: { state, ...(authenticated === undefined ? {} : { authenticated }) },
  models: { default: models[0] ?? "", options: models.map(id => ({ id, label: id })) },
});
const credit = (state: "available" | "unavailable" = "available") => engine(CREDIT, "openai-compat", true, ["claude-sonnet-5", "claude-haiku-4-5"], state);
const claude = (authenticated: boolean | undefined) => engine("claude", "claudeAgent", authenticated, ["claude-sonnet-5", "claude-opus-4-8"]);
const codex = (authenticated: boolean | undefined) => engine("codex", "codex", authenticated, ["gpt-5.5", "gpt-5.5-mini"]);
const bot = (id: string, modelSelection: ModelSelection, tasks: Task[] = []): Bot => ({ id, name: id, modelSelection, tasks: [{ threadId: `${id}-main` }, ...tasks] });

describe("which engine a Cloud home's bots run on while it has the trial credit", () => {
  let data: string;
  let bots: Bot[];
  let busy: Set<string>;
  let status: "active" | "used_up" | "ended";
  let saved: { defaultModelSelection?: ModelSelection; profile?: ModelSelection };
  let notices: Array<{ threadId: string; name: string }>;
  const storage = () => { const directory = join(data, "providers", "trial-credit"); mkdirSync(directory, { recursive: true }); return directory; };
  const moved = () => JSON.parse(readFileSync(join(storage(), "moved.json"), "utf8")) as Record<string, ModelSelection>;
  const find = (id: string) => bots.find(candidate => candidate.id === id)!;
  const make = () => createCreditMoves({
    credit: { owns: id => id === CREDIT, status: () => status, storage },
    store: {
      get bots() { return bots; },
      tasks: (botId: string) => find(botId).tasks,
      applyModelDefault: vi.fn((id: string, selection: ModelSelection) => { find(id).modelSelection = structuredClone(selection); return find(id); }),
      followBotModel: vi.fn((botId: string, threads: readonly string[]) => {
        const following = find(botId).tasks.filter(task => threads.includes(task.threadId) && task.modelSelection !== undefined);
        for (const task of following) delete task.modelSelection;
        return following.map(task => task.threadId);
      }),
      appendMessage: vi.fn((threadId: string, message: { tool?: { name: string } }) => { notices.push({ threadId, name: message.tool!.name }); return {}; }),
    } as unknown as CreditMovesOptions["store"],
    context: { company: id => id === CREDIT },
    defaults: () => [saved.defaultModelSelection, saved.profile],
    saveDefault: selection => { saved = { defaultModelSelection: selection, ...(saved.profile ? { profile: selection } : {}) }; },
    threadBusy: (botId, threadId) => busy.has(`${botId}/${threadId}`),
    engineName: id => ({ claude: "Claude", codex: "Codex" })[id] ?? id,
  });

  beforeEach(() => {
    data = mkdtempSync(join(tmpdir(), "omb-credit-moves-"));
    busy = new Set(); status = "active"; saved = {}; notices = [];
    bots = [
      bot("seeded", { instanceId: CREDIT, model: "claude-sonnet-5" }),
      // A desktop copy: its own Claude (signed out here), a thread on its Codex, and an engine only that desktop has.
      bot("copied", { instanceId: "claude", model: "claude-opus-4-8", effort: "high" }, [{ threadId: "copied-codex", modelSelection: { instanceId: "codex", model: "gpt-5.5" } }]),
      bot("endpoint", { instanceId: "desktop-endpoint", model: "llama-3" }),
      bot("haiku", { instanceId: CREDIT, model: "claude-haiku-4-5" }),
      bot("unset", { instanceId: "", model: "" }),
    ];
  });
  afterEach(() => rmSync(data, { recursive: true, force: true }));

  it("with nothing of the person's own signed in, a bot on an engine this Cloud can't run moves onto the credit's default, remembering where it came from", () => {
    make().settle([credit(), claude(false), codex(false)]);
    expect(find("copied").modelSelection).toEqual({ instanceId: CREDIT, model: "claude-sonnet-5" });
    expect(find("copied").tasks.every(task => task.modelSelection === undefined)).toBe(true);
    expect(find("endpoint").modelSelection).toEqual({ instanceId: CREDIT, model: "claude-sonnet-5" });
    // A pick on the credit stays, and an unset bot is the new-bot default's to fill.
    expect(find("haiku").modelSelection.model).toBe("claude-haiku-4-5");
    expect(find("unset").modelSelection).toEqual({ instanceId: "", model: "" });
    expect(moved()).toEqual({ copied: { instanceId: "claude", model: "claude-opus-4-8", effort: "high" }, endpoint: { instanceId: "desktop-endpoint", model: "llama-3" } });
    expect(notices).toEqual([]);
  });

  it("leaves a bot alone while one of its threads is working, an engine whose sign-in can't be read yet, and everything once the credit can't run", () => {
    busy.add("copied/copied-codex");
    make().settle([credit(), claude(false), codex(false)]);
    expect(find("copied").modelSelection.instanceId).toBe("claude");
    expect(find("copied").tasks[1]!.modelSelection?.instanceId).toBe("codex");
    busy.clear();
    make().settle([credit(), claude(undefined), codex(false)]);
    expect(find("copied").modelSelection.instanceId).toBe("claude");
    expect(find("copied").tasks[1]!.modelSelection).toBeUndefined();
    status = "used_up";
    find("endpoint").modelSelection = { instanceId: "desktop-endpoint", model: "llama-3" };
    make().settle([credit("unavailable"), claude(false), codex(false)]);
    expect(find("endpoint").modelSelection.instanceId).toBe("desktop-endpoint");
  });

  it("once an engine of the person's own is signed in, every bot on the credit moves to it: back where it came from when that runs, else the new-bot default", () => {
    saved = { defaultModelSelection: { instanceId: CREDIT, model: "claude-haiku-4-5" } };
    const moves = make();
    moves.settle([credit(), claude(false), codex(false)]);
    // Codex signs in: the copied bot came from Claude, still signed out, so it takes the default among the person's own.
    moves.settle([credit(), claude(false), codex(true)]);
    expect(find("copied").modelSelection).toEqual({ instanceId: "codex", model: "gpt-5.5" });
    expect(find("seeded").modelSelection).toEqual({ instanceId: "codex", model: "gpt-5.5" });
    expect(find("haiku").modelSelection).toEqual({ instanceId: "codex", model: "gpt-5.5" });
    expect(saved.defaultModelSelection).toEqual({ instanceId: "codex", model: "gpt-5.5" });
    expect(notices.filter(line => line.threadId === "copied-main")).toEqual([{ threadId: "copied-main", name: "notice: Codex is connected, so this conversation uses it now instead of the trial Claude credit." }]);
    expect(moved()).toEqual({});
  });

  it("puts a copied bot back on its own engine and model when that is the one signed in", () => {
    const moves = make();
    moves.settle([credit(), claude(false), codex(false)]);
    moves.settle([credit(), claude(true), codex(false)]);
    expect(find("copied").modelSelection).toEqual({ instanceId: "claude", model: "claude-opus-4-8" });
    expect(find("seeded").modelSelection).toEqual({ instanceId: "claude", model: "claude-sonnet-5" });
    // An engine only the desktop had never comes back here: the person's own default instead.
    expect(find("endpoint").modelSelection).toEqual({ instanceId: "claude", model: "claude-sonnet-5" });
    expect(notices.find(line => line.threadId === "copied-main")?.name).toContain("Claude is connected");
    expect(moved()).toEqual({});
  });

  it("an engine whose sign-in can't be read never takes the bots off the credit", () => {
    make().settle([credit(), claude(undefined), codex(false)]);
    expect(find("seeded").modelSelection.instanceId).toBe(CREDIT);
  });

  it("says when a send must settle first, by the engines' last known state", () => {
    const moves = make();
    const outside = [credit(), claude(false), codex(false)];
    expect(moves.due(find("copied"), "copied-main", outside)).toBe(true);
    expect(moves.due(find("seeded"), "seeded-main", outside)).toBe(false);
    find("seeded").tasks[0]!.modelSelection = { instanceId: "codex", model: "gpt-5.5" };
    expect(moves.due(find("seeded"), "seeded-main", outside)).toBe(true);
    expect(moves.due(find("haiku"), "haiku-main", [credit(), claude(true), codex(false)])).toBe(true);
    expect(moves.due(find("copied"), "copied-main", [credit(), claude(true), codex(false)])).toBe(false);
    status = "used_up";
    expect(moves.due(find("copied"), "copied-main", [credit("unavailable"), claude(false), codex(false)])).toBe(false);
  });

  it("when the credit's default changes, bots and saved defaults on the old default follow it; other picks stay", () => {
    saved = { defaultModelSelection: { instanceId: CREDIT, model: "claude-haiku-4-5" }, profile: { instanceId: CREDIT, model: "claude-haiku-4-5" } };
    find("haiku").tasks.push({ threadId: "haiku-pinned", modelSelection: { instanceId: CREDIT, model: "claude-haiku-4-5" } });
    make().followDefault("claude-haiku-4-5", "claude-sonnet-5");
    expect(find("haiku").modelSelection).toEqual({ instanceId: CREDIT, model: "claude-sonnet-5" });
    expect(find("haiku").tasks.every(task => task.modelSelection === undefined)).toBe(true);
    expect(find("copied").modelSelection.instanceId).toBe("claude");
    expect(saved).toEqual({ defaultModelSelection: { instanceId: CREDIT, model: "claude-sonnet-5" }, profile: { instanceId: CREDIT, model: "claude-sonnet-5" } });
  });

  it("reads back only well-formed records of where bots came from, and keeps none for a bot that is gone", () => {
    writeFileSync(join(storage(), "moved.json"), JSON.stringify({ copied: { instanceId: "claude", model: "claude-opus-4-8" }, gone: { instanceId: "claude", model: "x" }, bad: { instanceId: "../x y", model: 3 } }));
    const moves = make();
    moves.settle([credit(), claude(false), codex(false)]);
    expect(moved()).toEqual({ copied: { instanceId: "claude", model: "claude-opus-4-8" }, endpoint: { instanceId: "desktop-endpoint", model: "llama-3" } });
  });
});

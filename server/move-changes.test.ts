import { describe, expect, it } from "vitest";
import { hiddenFoldersIn, localEngine, moveFacts, teammatesOf, TEAMMATE_WINDOW_MS, type MoveChangesDeps } from "./move-changes.ts";
import type { BotRecord } from "./store.ts";

const NOW = 1_800_000_000_000;
const bot = (id: string, more: Partial<BotRecord> = {}) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), threadId: `t-${id}`, modelSelection: { instanceId: "claude", model: "m" }, tasks: [], ...more }) as unknown as BotRecord;
const opened = (by: string, at: number) => ({ threadId: `t-${by}-${at}`, openedBy: { botId: by, name: by, at } });

function deps(bots: BotRecord[], more: Partial<MoveChangesDeps> = {}): MoveChangesDeps {
  return { bots: () => bots, instances: () => ({}), mcpServers: () => ({}), skills: () => [], now: () => NOW, ...more };
}

describe("the places a skill reads that lending never opens", () => {
  it("finds ~/.claude, $HOME/.codex and a home path on macOS, Linux and Windows, at the end of a sentence too", () => {
    expect(hiddenFoldersIn("Read ~/.claude/projects/*.jsonl and $HOME/.codex/sessions")).toEqual(["~/.claude", "~/.codex"]);
    expect(hiddenFoldersIn("cat /Users/ash/.claude/history.jsonl; ls /home/ash/.ssh")).toEqual(["~/.claude", "~/.ssh"]);
    expect(hiddenFoldersIn("Open C:\\Users\\Ash\\.codex\\log and %USERPROFILE%\\AppData\\Roaming\\Mozilla\\x")).toEqual(["~/.codex", "~/AppData/Roaming/Mozilla"]);
    expect(hiddenFoldersIn("The sessions are in ~/.claude.")).toEqual(["~/.claude"]);
    expect(hiddenFoldersIn("Keys live in ~/.config/gh/hosts.yml")).toEqual(["~/.config/gh"]);
  });
  it("finds nothing a lent folder can reach: other hidden folders, project folders and relative paths", () => {
    expect(hiddenFoldersIn("Use ~/code/app, ~/.config/myapp, ~/.gemini and ./.github/workflows")).toEqual([]);
    expect(hiddenFoldersIn("~/.claudette is not ~/.claude")).toEqual(["~/.claude"]);
  });
});

describe("a model engine on this computer", () => {
  it("is one at a loopback or private address, named as the app names it", () => {
    expect(localEngine({ displayName: "Ollama", config: { url: "http://127.0.0.1:11434/v1" } }, "openai-compat-1")).toBe("Ollama");
    expect(localEngine({ config: { url: "http://192.168.1.20:1234/v1", catalog: "lmstudio" } }, "openai-compat-2")).toBe("LM Studio");
    expect(localEngine({ config: { url: "http://localhost:11434/v1", catalog: "ollama" } }, "x")).toBe("Ollama");
    expect(localEngine({ displayName: "Tailnet box", config: { url: "http://gpu.tail1234.ts.net:8080/v1" } }, "x")).toBe("Tailnet box");
  });
  it("is none at a public address, or without one", () => {
    expect(localEngine({ displayName: "OpenRouter", config: { url: "https://openrouter.ai/api/v1" } }, "x")).toBeNull();
    expect(localEngine({ displayName: "Claude" }, "claude")).toBeNull();
    expect(localEngine(undefined, "gone")).toBeNull();
  });
});

describe("the teammates a bot hands work to", () => {
  it("are the bots its hand-offs opened conversations with in the last 30 days", () => {
    const ada = bot("ada");
    const git = bot("git", { tasks: [opened("ada", NOW - 1000)] } as Partial<BotRecord>);
    const old = bot("old", { tasks: [opened("ada", NOW - TEAMMATE_WINDOW_MS - 1)] } as Partial<BotRecord>);
    const other = bot("other", { tasks: [opened("someone", NOW)] } as Partial<BotRecord>);
    expect(teammatesOf([ada], [ada, git, old, other], NOW).map((entry) => entry.id)).toEqual(["git"]);
  });
  it("include the bots its standing instructions @mention, and none that move with it", () => {
    const ada = bot("ada", { soul: "Hand reviews to @Reviewer and builds to @Builder." });
    const reviewer = bot("reviewer"), builder = bot("builder");
    expect(teammatesOf([ada], [ada, reviewer, builder], NOW).map((entry) => entry.id)).toEqual(["reviewer", "builder"]);
    expect(teammatesOf([ada, builder], [ada, reviewer, builder], NOW).map((entry) => entry.id)).toEqual(["reviewer"]);
  });
  it("are, for a Chief, the bots of the departments it runs", () => {
    const chief = bot("chief", { chiefOfStaff: true, section: "Ops", managedSections: ["Sales"] });
    const ops = bot("ops", { section: "Ops" }), sales = bot("sales", { section: "Sales" }), dev = bot("dev", { section: "Dev" });
    expect(teammatesOf([chief], [chief, ops, sales, dev], NOW).map((entry) => entry.id)).toEqual(["ops", "sales"]);
  });
  it("leave out archived bots, bots that moved and the other place's bots", () => {
    const ada = bot("ada", { soul: "@Gone @Away @There" });
    const gone = bot("gone", { hidden: true }), away = bot("away", { movedTo: { state: "moved" } } as unknown as Partial<BotRecord>), there = bot("there", { home: { place: "cloud", placeName: "My Cloud", botId: "x" } });
    expect(teammatesOf([ada], [ada, gone, away, there], NOW)).toEqual([]);
  });
});

describe("moveFacts", () => {
  it("reads a bot's whole setup: folder, local engine, tools that need this computer (not one My Cloud starts itself), skills reading places never lent, teammates", () => {
    const ada = bot("ada", { cwd: "/Users/ash/code/app", modelSelection: { instanceId: "openai-compat-1", model: "llama3.2" }, mcpServers: ["git", "web"] } as Partial<BotRecord>);
    const git = bot("git", { tasks: [opened("ada", NOW)] } as Partial<BotRecord>);
    const facts = moveFacts(deps([ada, git], {
      instances: () => ({ "openai-compat-1": { displayName: "Ollama", config: { url: "http://127.0.0.1:11434/v1" } } }),
      mcpServers: () => ({
        git: { command: "node", args: ["~/tools/git-mcp/index.js"], enabled: true },
        fetch: { command: "uvx", args: ["mcp-server-fetch"], enabled: true },
        web: { url: "https://mcp.example.com/mcp", enabled: true },
        other: { command: "npx", args: ["~/x"], enabled: true },
        off: { command: "npx", args: ["y"], enabled: false },
      }),
      skills: () => [
        { name: "weekly-digest", enabled: true, text: "Read ~/.claude/projects for the last session." },
        { name: "plain", enabled: true, text: "Summarise the README." },
        { name: "disabled", enabled: false, text: "Read ~/.codex" },
      ],
    }), ["ada"]);
    expect(facts).toEqual({ folder: "/Users/ash/code/app", folders: 1, paths: ["/Users/ash/code/app"], engine: "Ollama", tools: ["git"], skills: ["weekly-digest"], hidden: ["~/.claude"], teammates: ["Git"] });
  });

  it("finds nothing for a bot with nothing on this computer, and null for no known bot", () => {
    expect(moveFacts(deps([bot("ada")]), ["ada"])).toEqual({ folder: null, folders: 0, paths: [], engine: null, tools: [], skills: [], hidden: [], teammates: [] });
    expect(moveFacts(deps([bot("ada")]), ["nobody"])).toBeNull();
  });

  it("counts every working folder of a choice, and a server kept to one bot serves only that bot", () => {
    const ada = bot("ada", { cwd: "/a" }), bo = bot("bo", { cwd: "/b" });
    const facts = moveFacts(deps([ada, bo], { mcpServers: () => ({ mine: { command: "node", args: ["s.js"], enabled: true, bot: "other" } }) }), ["ada", "bo"]);
    expect(facts).toMatchObject({ folder: "/a", folders: 2, paths: ["/a", "/b"], tools: [] });
  });
});

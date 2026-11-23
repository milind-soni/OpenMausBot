import { describe, expect, it } from "vitest";

import { placeChild, placeStoragePath, STORAGE_CATEGORIES, storageSegments, type Placement, type StorageScope } from "./disk-categories.ts";

/** Places a path the way the walk does: each segment from its parent's placement. */
function place(scope: StorageScope, path: string, directory = false): Placement {
  const segments = storageSegments(path);
  let placement: Placement = { category: scope === "data" ? "settings" : "other", final: false };
  segments.forEach((_, index) => { placement = placeChild(placement, scope, segments.slice(0, index + 1), index < segments.length - 1 || directory); });
  return placement;
}
const category = (scope: StorageScope, path: string, directory = false) => place(scope, path, directory).category;

describe("storage categories", () => {
  it("files every data-folder path class where its writer puts it", () => {
    const cases: Array<[string, string]> = [
      ["messages.db", "conversations"], ["messages.db-wal", "conversations"], ["runtime.db-shm", "conversations"], ["bursts.db", "conversations"],
      ["events/thread-1.ndjson", "conversations"], ["native/thread-1.ndjson", "conversations"], ["checkpoints/a/b", "conversations"], ["memory-journal/bot.jsonl", "conversations"],
      ["config.json", "settings"], ["bots.json", "settings"], ["routines.json", "settings"], ["sessions.json", "settings"], ["environment-id", "settings"],
      ["logins.json.enc", "settings"], ["providers/claude/auth.json", "settings"], ["people/a/b.json", "settings"], ["skills/x/SKILL.md", "settings"],
      ["engine-homes/team/.claude/projects/x.jsonl", "engine_state"], ["pi-sessions/local/k", "engine_state"],
      ["workspaces/bot1/notes.md", "bot_files"], ["task-workspaces/bot1/thread1/out.csv", "bot_files"], ["bots/bot1/SOUL.md", "bot_files"],
      ["bots/bot1/data.duckdb", "bot_files"], ["team-files/report.pdf", "bot_files"], ["vm-homes/abc/x", "bot_files"],
      ["attachments/a.png", "attachments"], ["attachment-originals/a", "attachments"], ["box-uploads/b/t/f", "attachments"], ["browser-uploads/f", "attachments"],
      ["tool-results/t/r.json", "attachments"], ["meetings/m/rec.wav", "attachments"], ["browser/downloads/abc/file.zip", "attachments"],
      ["sync/lent/f", "synced"], ["sync/trash/123", "trash"], ["sync/uploads/part", "temp"], ["engine-homes/.held/old", "trash"],
      [".backups/job/staged/data", "backups"], ["doctor-backups/2026/x", "backups"],
      ["browser/profiles/abc/Default/Cookies", "browser_profiles"], ["browser/profiles/abc/Default/Login Data", "browser_profiles"],
      ["browser/profiles/abc/Local State", "browser_profiles"], ["browser/workspace-id", "browser_profiles"], ["agent-browser-profiles/abc/Default/Cookies", "browser_profiles"],
      ["browser/profiles/abc/Default/Cache/Cache_Data/f", "browser_cache"], ["browser/profiles/abc/Default/Code Cache/js/f", "browser_cache"],
      ["browser/profiles/abc/GrShaderCache/f", "browser_cache"], ["browser/profiles/abc/Default/Service Worker/ScriptCache/f", "browser_cache"], ["browser/profiles/abc/Default/Service Worker/CacheStorage/f", "browser_cache"],
      ["agent-browser-profiles/abc/Default/GPUCache/f", "browser_cache"], ["browser/temp/abc/Default/Cookies", "browser_cache"], ["browser/screenshots/abc/1.png", "attachments"],
      ["browser/profiles/abc/Default/Service Worker/Database/x", "browser_profiles"], ["browser/profiles/abc/Default/IndexedDB/x", "browser_profiles"],
      ["chrome-profile/Default/Cookies", "browser_profiles"], [".agent-browser/sessions/x", "browser_profiles"],
      ["vm-homes/abc/.browser-profiles/p/Cookies", "browser_profiles"], ["vm-home/.browser-profiles/p", "browser_profiles"], ["vm-home/work/x", "bot_files"],
      ["dist-native/cloudflared", "engine_clis"],
      ["tools/chrome/153/linux64/chrome", "browser_engines"], ["tools/agent-browser/1.2/agent-browser", "browser_engines"],
      ["tools/npm/lib/node_modules/@anthropic-ai/claude-code/cli.js", "engine_clis"], ["tools/standalone/x", "engine_clis"], ["tools/bitwarden/2026.1.0/bw", "engine_clis"],
      ["tools/bitwarden/account/data.json", "settings"], ["tools/bitwarden/notes", "other"], ["tools/something-new/x", "other"], ["tools/npm-home/.npmrc", "settings"],
      ["scrcpy/scrcpy-server-v3", "engine_clis"], ["tools/npm-home/cache/_cacache/x", "packages"],
      ["logs/service.log", "logs"], ["evidence/thread/1.png", "attachments"], ["decisions.ndjson", "settings"], ["decisions.ndjson.1", "settings"], ["decisions/2026-11.ndjson", "settings"], ["decider-log/x", "logs"], ["engine-runs/tag/pid", "logs"], ["perf-timings.json", "logs"],
      ["perf-stalls.json", "logs"], ["launch-timings.json", "logs"], ["server.log", "logs"],
      ["cache/node-compile/x", "caches"], ["duckdb-extensions/v1/x", "caches"], ["org-library/blobs/abc", "caches"], ["org-library/catalog.json", "settings"],
      ["tmp/omb-cline-mcp-1/x", "temp"], ["tunnel-runtime/x", "temp"], ["tools/.npm-staging-1/x", "temp"], ["tools/.npm-aside-1/x", "temp"],
      ["bots/bot1/data-tmp/spill", "temp"], ["config.json.123.0f8fad5b-d9cb-469f-a165-70867728950e.tmp", "temp"], ["notes.tmp", "settings"],
      ["browser/audiences.json", "browser_profiles"], ["browser/panes/abc", "browser_profiles"], ["browser/identity/x.json", "browser_cache"], ["browser/displays/1/x", "browser_cache"],
      ["browser/something-new", "other"], [".cache/x", "other"],
      ["something-new/x", "other"],
    ];
    for (const [path, expected] of cases) expect([path, category("data", path)]).toEqual([path, expected]);
  });

  it("files every HOME path class: engines, packages, caches, browser engines, synced folders, the rest other", () => {
    const cases: Array<[string, string]> = [
      [".claude/projects/-data/x.jsonl", "engine_state"], [".claude.json", "engine_state"], [".codex/sessions/x", "engine_state"], [".grok/auth.json", "engine_state"],
      [".local/share/opencode/x", "engine_state"],
      [".local/share/claude/versions/2.1.0", "engine_clis"], [".grok/bin/grok", "engine_clis"], [".grok/auth.json", "engine_state"],
      [".local/bin/my-script", "other"], [".cargo/bin/tool", "other"], [".cargo/registry/cache/x", "packages"], ["go/pkg/mod/x", "packages"], ["go/src/app/main.go", "other"],
      [".gradle/caches/x", "packages"], [".m2/settings.xml", "other"],
      [".npm/_cacache/x", "packages"], [".cache/pip/x", "packages"], [".cache/uv/x", "packages"], [".local/share/pnpm/store/x", "packages"], [".cargo/registry/x", "packages"],
      [".cache/ms-playwright/chromium-1/chrome", "browser_engines"], [".agent-browser/browsers/chrome/x", "browser_engines"],
      [".agent-browser/sessions/s.json", "browser_profiles"],
      [".cache/opencode/models.json", "caches"], [".cache/something", "other"], [".cache/huggingface/token", "other"],
      [".local/share/pnpm/store/v3/x", "packages"], [".local/share/pnpm/global/5/x", "other"], [".local/state/claude/locks/x", "engine_clis"], [".local/share/uv/tools/x", "other"],
      [".config/gh/hosts.yml", "settings"], [".omb-cloud-home.json", "settings"], [".omb-edge/caddy/x", "settings"],
      ["Synced/Desktop/a.txt", "synced"], [".local/share/Trash/files/x", "trash"],
      ["lost+found/x", "other"], ["acme-merger/plan.md", "other"], [".local/lib/x", "other"],
    ];
    for (const [path, expected] of cases) expect([path, category("home", path)]).toEqual([path, expected]);
  });

  it("counts node_modules in work folders as packages, still the bot's, and leaves tool installs alone", () => {
    expect(place("data", "task-workspaces/bot1/thread1/app/node_modules/react/index.js")).toMatchObject({ category: "packages", botId: "bot1" });
    expect(place("data", "workspaces/bot1/node_modules/x")).toMatchObject({ category: "packages", botId: "bot1" });
    expect(category("home", "projects/node_modules/x")).toBe("packages");
    expect(category("data", "tools/npm/lib/node_modules/x")).toBe("engine_clis");
    expect(category("home", ".claude/local/node_modules/x")).toBe("engine_state");
  });

  it("names a bot folder's id only when it looks like an id, and names nothing else from the disk but OTHER_NAMES", () => {
    expect(place("data", "workspaces/bot_1-a/f").botId).toBe("bot_1-a");
    expect(place("data", "bots/bot1/data-tmp/x")).toMatchObject({ category: "temp", botId: "bot1" });
    expect(place("data", "workspaces/Ada's plans/f").botId).toBeUndefined();
    expect(place("data", "something-new/x").otherName).toBeUndefined();
    expect(place("home", "lost+found/x")).toMatchObject({ category: "other", otherName: "lost+found" });
    expect(place("home", "acme-merger/plan.md").otherName).toBeUndefined();
    expect(place("home", ".bash_history")).toMatchObject({ category: "other", otherName: ".bash_history" });
  });

  it("reads a Windows relative path the same way", () => {
    expect(storageSegments("task-workspaces\\bot1\\thread1\\a.txt")).toEqual(["task-workspaces", "bot1", "thread1", "a.txt"]);
    expect(storageSegments("./browser//profiles/abc/")).toEqual(["browser", "profiles", "abc"]);
    expect(category("data", "browser\\profiles\\abc\\Default\\Cache\\f")).toBe("browser_cache");
  });

  it("tells a first-level file from a folder of the same name", () => {
    expect(placeStoragePath("data", ["logs"], false).category).toBe("settings");
    expect(placeStoragePath("data", ["logs"], true).category).toBe("logs");
  });

  it("pins every category's class: only caches, downloads and scratch space are rebuildable", () => {
    expect(STORAGE_CATEGORIES).toEqual({
      conversations: "precious", settings: "precious", engine_state: "precious", browser_profiles: "precious",
      bot_files: "work", attachments: "work", synced: "work", backups: "work", trash: "work", other: "work", logs: "work",
      browser_cache: "rebuildable", browser_engines: "rebuildable", engine_clis: "rebuildable", packages: "rebuildable", caches: "rebuildable", temp: "rebuildable",
    });
  });
});

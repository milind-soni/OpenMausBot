import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Audience } from "../audience.ts";
import type { ProviderInstance } from "../contracts.ts";
import { spawnCli } from "../procs.ts";
import { EngineHomes, engineHomes, withEngineHomes } from "./engine-homes.ts";
import { audienceHome } from "./layout.ts";

const posix = describe.skipIf(process.platform === "win32");
let root = "", home = "", dataDir = "";
const audiences: Record<string, Audience> = { "t-bob": "member:p_bob", "t-owner": "member:p_olive", "t-main": "team" };
const setup = () => ({ dataDir, serverHome: home, audienceOf: (threadId: string) => audiences[threadId] ?? "team", threads: () => [], log: () => {} });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omb-engine-homes-"));
  home = join(root, "home");
  dataDir = join(home, ".openmausbot");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok-1" } }));
});
afterEach(() => {
  engineHomes.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("engine homes at run time", () => {
  it("change nothing off a Team Cloud: no home for any spawn, and adapters are not wrapped", () => {
    const homes = new EngineHomes();
    expect(homes.within("t-bob", () => homes.forSpawn({ HOME: home }))).toBeNull();
    expect(homes.within("t-bob", () => homes.scope())).toBeNull();
    const adapter = { sendTurn: async () => ({ turnId: "x" }) };
    const instance = { adapter } as unknown as ProviderInstance;
    expect(withEngineHomes(instance, homes).adapter).toBe(adapter);
  });

  it("on a Team Cloud give a conversation's spawns its audience's home, made private, with the team's sign-in in it", () => {
    const homes = new EngineHomes();
    homes.start(setup());
    expect(homes.forSpawn({ HOME: home })).toBeNull();
    const homed = homes.within("t-bob", () => homes.forSpawn({ HOME: home, PATH: "/usr/bin" }))!;
    const bob = audienceHome(dataDir, "member:p_bob");
    expect(homed.env).toEqual({ HOME: bob, PATH: "/usr/bin" });
    if (process.platform !== "win32") expect(statSync(bob).mode & 0o077).toBe(0);
    expect(JSON.parse(readFileSync(join(bob, ".claude", ".credentials.json"), "utf8")).claudeAiOauth.accessToken).toBe("tok-1");
    expect(homes.within("t-owner", () => homes.forSpawn({ HOME: home }))!.home).toBe(audienceHome(dataDir, "member:p_olive"));
    expect(homes.within("t-bob", () => homes.scope())).not.toBe(homes.within("t-owner", () => homes.scope()));
    expect(existsSync(join(dataDir, "engine-homes", ".migrated"))).toBe(true);
  });

  it("wrap every turn and keep-warm ping in its conversation", async () => {
    const homes = new EngineHomes();
    homes.start(setup());
    const seen: Array<string | null> = [];
    const instance = withEngineHomes({ adapter: {
      sendTurn: async () => { await new Promise((resolve) => setTimeout(resolve, 1)); seen.push(homes.scope()); return { turnId: "x" }; },
      cacheKeepWarm: { ping: async () => { seen.push(homes.scope()); return { ok: false, reason: "test" }; }, hold: () => false },
    } } as unknown as ProviderInstance, homes);
    await instance.adapter.sendTurn({ threadId: "t-bob", text: "hi" });
    await instance.adapter.cacheKeepWarm!.ping("t-main");
    expect(seen).toEqual([expect.stringMatching(/^member-[0-9a-f]{16}$/), "team"]);
  });
});

posix("a bot's engine spawned on a Team Cloud", () => {
  const homeOf = (owner: "bot" | "openmausbot", options: { engineHome?: boolean } = {}) => new Promise<string>((resolve, reject) => {
    const child = spawnCli("/bin/sh", ["-c", 'printf %s "$HOME"'], { env: { PATH: "/usr/bin:/bin", HOME: home }, stdio: ["ignore", "pipe", "pipe"], ...options }, owner);
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.once("error", reject);
    child.once("close", () => resolve(out));
  });

  it("runs in its conversation's engine home; the server's own spawns keep the server's HOME", async () => {
    engineHomes.start(setup());
    expect(await engineHomes.within("t-bob", () => homeOf("bot"))).toBe(audienceHome(dataDir, "member:p_bob"));
    expect(await engineHomes.within("t-main", () => homeOf("bot"))).toBe(audienceHome(dataDir, "team"));
    expect(await engineHomes.within("t-bob", () => homeOf("openmausbot"))).toBe(home);
    expect(await engineHomes.within("t-bob", () => homeOf("openmausbot", { engineHome: true }))).toBe(audienceHome(dataDir, "member:p_bob"));
    expect(await homeOf("bot")).toBe(home);
    engineHomes.stop();
    expect(await engineHomes.within("t-bob", () => homeOf("bot"))).toBe(home);
  });
});

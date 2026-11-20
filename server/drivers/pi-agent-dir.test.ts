import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { ensurePiInjectModel } from "./pi.ts";
import { ownPiAgentDir, piAgentDir, readPiDefaultModel, withOwnPiAgentDir } from "./pi-agent-dir.ts";
import { encodeInjectId } from "./local-inject.ts";

/** The same file or folder: a link on most systems, a hard link where Windows refuses a file link. */
const same = (a: string, b: string) => {
  const [x, y] = [statSync(a, { bigint: true }), statSync(b, { bigint: true })];
  return x.ino === y.ino && x.dev === y.dev;
};

describe("MausBot's own Pi agent folder", () => {
  let root: string, home: string, dataDir: string, person: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-pi-agent-dir-"));
    home = join(root, "home");
    dataDir = join(home, ".openmausbot");
    person = join(home, ".pi", "agent");
    mkdirSync(join(person, "extensions"), { recursive: true });
    mkdirSync(join(person, "bin"), { recursive: true });
    writeFileSync(join(person, "AGENTS.md"), "My own instructions\n");
    writeFileSync(join(person, "APPEND_SYSTEM.md"), "Always do it my way\n");
    writeFileSync(join(person, "mcp.json"), '{"mcpServers":{}}');
    writeFileSync(join(person, "trust.json"), "{}");
    writeFileSync(join(person, "extensions", "edit.ts"), "export default () => {};\n");
    writeFileSync(join(person, "bin", "rg"), "");
    writeFileSync(join(person, "auth.json"), '{"anthropic":{"type":"oauth"}}');
    writeFileSync(join(person, "models.json"), '{"providers":{"mine":{"models":[]}}}');
    writeFileSync(join(person, "settings.json"), JSON.stringify({
      defaultProvider: "anthropic", defaultModel: "claude-x", transport: "sse", packages: ["npm:mine"], extensions: ["x"], skills: ["s"], prompts: ["p"],
    }));
  });
  afterEach(async () => { await removeTempDir(root); });

  const env = () => ({ HOME: home });

  it("carries the login, providers and model settings over, and none of the person's instructions, extensions or MCP servers", () => {
    const own = ownPiAgentDir(env(), "pi-1", dataDir, false)!;
    expect(own.startsWith(join(dataDir, "providers", "pi-own"))).toBe(true);
    expect(readdirSync(own).filter((name) => !name.startsWith(".")).sort()).toEqual(["auth.json", "bin", "models.json", "settings.json"]);
    expect(same(join(own, "auth.json"), join(person, "auth.json"))).toBe(true);
    expect(same(join(own, "bin"), join(person, "bin"))).toBe(true);
    expect(lstatSync(join(own, "models.json")).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(join(own, "settings.json"), "utf8"))).toEqual({ defaultProvider: "anthropic", defaultModel: "claude-x", transport: "sse" });
    expect(readPiDefaultModel({ ...env(), PI_CODING_AGENT_DIR: own })).toBe("anthropic/claude-x");
    // Each instance gets its own.
    expect(ownPiAgentDir(env(), "pi-2", dataDir, false)).not.toBe(own);
  });

  it("points the environment at it, and leaves it alone on a Team Cloud or when the person's folder is MausBot's already", () => {
    const pointed = withOwnPiAgentDir(env(), "pi-1", dataDir, false);
    expect(piAgentDir(pointed)).toBe(pointed.PI_CODING_AGENT_DIR);
    expect(pointed.PI_CODING_AGENT_DIR!.startsWith(dataDir)).toBe(true);
    expect(withOwnPiAgentDir(env(), "pi-1", dataDir, true)).toEqual(env());
    const inData = { ...env(), PI_CODING_AGENT_DIR: join(dataDir, "elsewhere") };
    expect(withOwnPiAgentDir(inData, "pi-1", dataDir, false)).toEqual(inData);
  });

  it("copies from a Pi agent folder the person named themselves", () => {
    const named = join(root, "pi-work");
    mkdirSync(named, { recursive: true });
    writeFileSync(join(named, "auth.json"), "{}");
    writeFileSync(join(named, "AGENTS.md"), "Work instructions\n");
    const own = ownPiAgentDir({ ...env(), PI_CODING_AGENT_DIR: named }, "pi-1", dataDir, false)!;
    expect(same(join(own, "auth.json"), join(named, "auth.json"))).toBe(true);
    expect(existsSync(join(own, "AGENTS.md"))).toBe(false);
  });

  it("keeps MausBot's local models out of the person's models.json, and picks up the person's later changes", () => {
    const pointed = withOwnPiAgentDir(env(), "pi-1", dataDir, false);
    const own = pointed.PI_CODING_AGENT_DIR!;
    ensurePiInjectModel(encodeInjectId("omlx", "MiniMax-M3-4bit"), pointed);
    expect(readFileSync(join(person, "models.json"), "utf8")).toBe('{"providers":{"mine":{"models":[]}}}');
    expect(JSON.parse(readFileSync(join(own, "models.json"), "utf8")).providers.omlx).toBeDefined();
    // Unchanged on the person's side: the turn's own rows stay.
    ownPiAgentDir(env(), "pi-1", dataDir, false);
    expect(JSON.parse(readFileSync(join(own, "models.json"), "utf8")).providers.omlx).toBeDefined();
    writeFileSync(join(person, "models.json"), '{"providers":{"mine":{"models":[]},"theirs":{"models":[]}}}');
    ownPiAgentDir(env(), "pi-1", dataDir, false);
    expect(JSON.parse(readFileSync(join(own, "models.json"), "utf8")).providers.theirs).toBeDefined();
  });

  it("works with nothing to carry over, and links a login the person makes later", () => {
    rmSync(join(home, ".pi"), { recursive: true, force: true });
    const own = ownPiAgentDir(env(), "pi-1", dataDir, false)!;
    expect(readdirSync(own)).toEqual([]);
    // What Pi wrote for itself while the person had no login gives way to theirs.
    writeFileSync(join(own, "auth.json"), "{}");
    mkdirSync(person, { recursive: true });
    writeFileSync(join(person, "auth.json"), '{"openai":{"type":"api_key"}}');
    ownPiAgentDir(env(), "pi-1", dataDir, false);
    expect(same(join(own, "auth.json"), join(person, "auth.json"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("drops a link to a login the person removed, so Pi never writes through it", () => {
    const own = ownPiAgentDir(env(), "pi-1", dataDir, false)!;
    rmSync(join(person, "auth.json"));
    ownPiAgentDir(env(), "pi-1", dataDir, false);
    expect(() => lstatSync(join(own, "auth.json"))).toThrow();
    // A link MausBot did not make that points elsewhere is replaced too.
    writeFileSync(join(person, "auth.json"), "{}");
    symlinkSync(join(root, "elsewhere.json"), join(own, "auth.json"));
    ownPiAgentDir(env(), "pi-1", dataDir, false);
    expect(same(join(own, "auth.json"), join(person, "auth.json"))).toBe(true);
  });
});

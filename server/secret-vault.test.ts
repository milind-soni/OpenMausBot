import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NOT_A_REF_TEXT, SECRET_FILE_TTL_MS, SECRET_FOLDER, SECRET_REF_TTL_MS, SecretVault } from "./secret-vault.ts";

const ATLAS = { botId: "atlas", threadId: "thread-1" };
const MCP = (path: readonly string[]) => path.length === 2 && (path[0] === "env" || path[0] === "headers");
const posix = describe.skipIf(process.platform === "win32");

let root = "";
let now = 1_000_000;
const clock = () => now;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omb-secret-vault-"));
  now = 1_000_000;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("secretRef", () => {
  it("swaps a ref for its value inside text or as {secretRef}, and spends it only on commit", () => {
    const vault = new SecretVault(clock);
    const ref = vault.saveRef(ATLAS, "card-1", "Notion key", "ntn_canary_value");
    expect(ref).toMatch(/^secret-ref:[0-9a-f]{32}$/);
    const body = { name: "notion", url: "https://mcp.example.test", headers: { Authorization: `Bearer ${ref}` }, env: { NOTION: { secretRef: ref } } };
    const first = vault.redeem(body, ATLAS, MCP, "env and headers");
    expect(first.ok && first.value).toEqual({ ...body, headers: { Authorization: "Bearer ntn_canary_value" }, env: { NOTION: "ntn_canary_value" } });
    expect(body.headers.Authorization).toBe(`Bearer ${ref}`);
    // Not committed: a refused save keeps it usable.
    expect(vault.redeem(body, ATLAS, MCP, "env and headers").ok).toBe(true);
    if (first.ok) first.commit();
    const again = vault.redeem(body, ATLAS, MCP, "env and headers");
    expect(again).toEqual({ ok: false, error: `${ref} was already used: each secretRef works once. Ask again with request_credential.` });
  });

  it("works only for the bot and conversation that asked", () => {
    const vault = new SecretVault(clock);
    const ref = vault.saveRef(ATLAS, "card-1", "Notion key", "ntn_canary_value");
    const wrongBot = vault.redeem({ env: { K: ref } }, { botId: "pixel", threadId: "thread-1" }, MCP, "env");
    const wrongThread = vault.redeem({ env: { K: ref } }, { botId: "atlas", threadId: "thread-2" }, MCP, "env");
    for (const result of [wrongBot, wrongThread]) {
      expect(result).toEqual({ ok: false, error: `${ref} was given to another bot or conversation. Ask the person here with request_credential.` });
    }
    expect(vault.redeem({ env: { K: ref } }, ATLAS, MCP, "env").ok).toBe(true);
  });

  it("expires an hour after saving, and says so", () => {
    const vault = new SecretVault(clock);
    const ref = vault.saveRef(ATLAS, "card-1", "Notion key", "ntn_canary_value");
    now += SECRET_REF_TTL_MS - 1;
    expect(vault.savedFor("card-1")).toEqual({ ref });
    now += 1;
    expect(vault.savedFor("card-1")).toBeNull();
    expect(vault.redeem({ env: { K: ref } }, ATLAS, MCP, "env")).toEqual({
      ok: false, error: `${ref} expired: a secretRef lasts an hour after the person saves it. Ask again with request_credential.`,
    });
  });

  it("names an unknown ref, a ref outside the allowed fields and a secret file path plainly", () => {
    const vault = new SecretVault(clock);
    const ref = vault.saveRef(ATLAS, "card-1", "Notion key", "ntn_canary_value");
    const unknown = `secret-ref:${"0".repeat(32)}`;
    expect(vault.redeem({ env: { K: unknown } }, ATLAS, MCP, "env").ok).toBe(false);
    expect(vault.redeem({ args: [ref] }, ATLAS, MCP, "env and headers")).toEqual({ ok: false, error: "A secretRef works only in env and headers." });
    expect(vault.redeem({ env: { K: `/data/workspaces/atlas/${SECRET_FOLDER}/thread-1/card-2` } }, ATLAS, MCP, "env")).toEqual({ ok: false, error: NOT_A_REF_TEXT });
    expect(vault.redeem({ env: { K: { secretRef: "not-a-ref" } } }, ATLAS, MCP, "env").ok).toBe(false);
    // Nothing above spent it.
    expect(vault.redeem({ env: { K: ref } }, ATLAS, MCP, "env").ok).toBe(true);
  });

  it("masks a live value in any text redaction sees", () => {
    const vault = new SecretVault(clock);
    vault.saveRef(ATLAS, "card-1", "Notion key", "ntn_canary_value");
    expect(vault.scrub("token=ntn_canary_value; url=ntn_canary_value")).not.toContain("ntn_canary_value");
    now += SECRET_FILE_TTL_MS;
    expect(vault.scrub("ntn_canary_value")).toBe("ntn_canary_value");
  });
});

posix("secret files", () => {
  const home = () => ({ host: join(root, "workspaces", "atlas"), shown: join(root, "workspaces", "atlas") });

  it("writes an owner-only file in owner-only folders and returns its path", () => {
    const vault = new SecretVault(clock);
    const shown = vault.saveFile(ATLAS, "card-1", "sk_canary_file", home());
    const file = join(root, "workspaces", "atlas", SECRET_FOLDER, "thread-1", "card-1");
    expect(shown).toBe(file);
    expect(readFileSync(file, "utf8")).toBe("sk_canary_file");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "workspaces", "atlas", SECRET_FOLDER)).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "workspaces", "atlas", SECRET_FOLDER, "thread-1")).mode & 0o777).toBe(0o700);
    expect(vault.savedFor("card-1")).toEqual({ file });
  });

  it("closes a secrets folder someone else opened up before writing into it", () => {
    const vault = new SecretVault(clock);
    mkdirSync(join(home().host, SECRET_FOLDER), { recursive: true, mode: 0o755 });
    chmodSync(join(home().host, SECRET_FOLDER), 0o755);
    vault.saveFile(ATLAS, "card-1", "sk_canary_file", home());
    expect(statSync(join(home().host, SECRET_FOLDER)).mode & 0o777).toBe(0o700);
  });

  it("gives a Local VM's path as the bot's commands there see it", () => {
    const vault = new SecretVault(clock);
    const shown = vault.saveFile(ATLAS, "card-1", "sk_canary_file", { host: join(root, "vm-home"), shown: "/home/cua/workspace" });
    expect(shown).toBe(`/home/cua/workspace/${SECRET_FOLDER}/thread-1/card-1`);
    expect(readFileSync(join(root, "vm-home", SECRET_FOLDER, "thread-1", "card-1"), "utf8")).toBe("sk_canary_file");
  });

  it("refuses a folder the bot replaced with a link, so the value never lands where it points", () => {
    const vault = new SecretVault(clock);
    const elsewhere = join(root, "synced-folder");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(home().host, { recursive: true });
    symlinkSync(elsewhere, join(home().host, SECRET_FOLDER));
    expect(() => vault.saveFile(ATLAS, "card-1", "sk_canary_file", home())).toThrow(/not a plain folder/);
    expect(existsSync(join(elsewhere, "thread-1"))).toBe(false);
  });

  it("deletes a file a day after its card was saved, when its card or conversation is gone, and never because of mtime", () => {
    const vault = new SecretVault(clock);
    vault.saveFile(ATLAS, "card-1", "sk_one", home());
    vault.saveFile({ botId: "atlas", threadId: "thread-2" }, "card-2", "sk_two", home());
    vault.saveFile(ATLAS, "card-3", "sk_three", home());
    const base = join(root, "workspaces", "atlas", SECRET_FOLDER);
    const saved: Record<string, number> = { "card-1": now, "card-3": now };
    const savedAt = (_thread: string, card: string) => saved[card] ?? null;
    const exists = (thread: string) => thread === "thread-1";
    // A touched file does not live longer: the card's time counts.
    utimesSync(join(base, "thread-1", "card-1"), new Date(now + SECRET_FILE_TTL_MS * 2), new Date(now + SECRET_FILE_TTL_MS * 2));
    vault.sweep([join(root, "workspaces", "atlas")], savedAt, exists);
    expect(existsSync(join(base, "thread-1", "card-1"))).toBe(true);
    expect(existsSync(join(base, "thread-2"))).toBe(false);
    delete saved["card-3"];
    now += SECRET_FILE_TTL_MS;
    vault.sweep([join(root, "workspaces", "atlas")], savedAt, exists);
    expect(existsSync(join(base, "thread-1"))).toBe(false);
    expect(vault.savedFor("card-1")).toBeNull();
  });

  it("removes a link planted in the secrets folder without following it", () => {
    const vault = new SecretVault(clock);
    const keep = join(root, "keep");
    mkdirSync(keep, { recursive: true });
    writeFileSync(join(keep, "important"), "x");
    const base = join(root, "workspaces", "atlas", SECRET_FOLDER);
    mkdirSync(base, { recursive: true });
    symlinkSync(keep, join(base, "thread-1"));
    vault.sweep([join(root, "workspaces", "atlas")], () => now, () => true);
    expect(lstatSync(base).isDirectory()).toBe(true);
    expect(existsSync(join(base, "thread-1"))).toBe(false);
    expect(readFileSync(join(keep, "important"), "utf8")).toBe("x");
  });
});

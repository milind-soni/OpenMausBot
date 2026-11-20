import "../testing/scrub-ambient-omb-env.ts";

import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { inBotShell } from "./bot-shell.ts";
import { openClient } from "./client.ts";
import { cliConfigDir, SavedServers, type SecurityRunner } from "./saved-servers.ts";

const home = mkdtempSync(join(tmpdir(), "omb-saved-"));
afterAll(() => removeTempDir(home));

/** A stand-in for macOS `security`: a map, so no keychain is touched. Records every argv to prove a session is never on one. */
function fakeKeychain() {
  const items = new Map<string, string>();
  const argv: string[][] = [];
  const runner: SecurityRunner = (args, stdin) => {
    argv.push([...args]);
    if (args[0] === "-i") {
      const match = /^add-generic-password -U -s "([^"]+)" -a "([^"]+)" -l "[^"]*" -w "([^"]+)"\n$/.exec(stdin ?? "");
      if (!match) return { status: 1, stdout: "" };
      items.set(`${match[1]}/${match[2]}`, match[3]!);
      return { status: 0, stdout: "" };
    }
    const service = args[args.indexOf("-s") + 1], account = args[args.indexOf("-a") + 1];
    if (args[0] === "find-generic-password") {
      const found = items.get(`${service}/${account}`);
      return found ? { status: 0, stdout: `${found}\n` } : { status: 44, stdout: "" };
    }
    if (args[0] === "delete-generic-password") return { status: items.delete(`${service}/${account}`) ? 0 : 44, stdout: "" };
    return { status: 1, stdout: "" };
  };
  return { items, argv, runner };
}

const server = { url: "http://127.0.0.1:8799", environmentId: "env-1", label: "Studio", sessionId: "s1", scopes: ["admin", "client"], expiresAt: 1 };

describe("saved servers", () => {
  it("lives under the command's own HOME or XDG_CONFIG_HOME, never the process's", () => {
    expect(cliConfigDir({ HOME: "/h" }, "darwin")).toBe(join("/h", ".config", "openmausbot"));
    expect(cliConfigDir({ HOME: "/h", XDG_CONFIG_HOME: "/x" }, "linux")).toBe(join("/x", "openmausbot"));
    expect(cliConfigDir({ USERPROFILE: "C:\\u", APPDATA: "C:\\a" }, "win32")).toBe(join("C:\\a", "openmausbot"));
    expect(cliConfigDir({}, "linux")).toBeNull();
  });

  it("keeps the session in the Keychain on a Mac, fed on stdin so it is never on a command line", () => {
    const keychain = fakeKeychain();
    const saved = new SavedServers({ env: { HOME: join(home, "mac") }, platform: "darwin", security: keychain.runner });
    expect(saved.save("local", server, "omb_sess_secret_value")).toBe("keychain");
    expect(keychain.items.get("openmausbot-cli/local")).toBe("omb_sess_secret_value");
    expect(keychain.argv.flat().join(" ")).not.toContain("omb_sess_secret_value");
    const file = join(home, "mac", ".config", "openmausbot", "servers.json");
    expect(readFileSync(file, "utf8")).not.toContain("omb_sess_secret_value");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(saved.token("local")).toBe("omb_sess_secret_value");
    expect(saved.current()).toMatchObject({ name: "local", url: server.url, store: "keychain" });
    saved.forget("local");
    expect(keychain.items.size).toBe(0);
    expect(saved.current()).toBeNull();
  });

  it.skipIf(process.platform === "win32")("falls back to a file only this user can read when there is no Keychain", () => {
    const saved = new SavedServers({ env: { HOME: join(home, "linux") }, platform: "linux", security: () => { throw new Error("no security on Linux"); } });
    expect(saved.save("box", { ...server, url: "https://maus.example.com" }, "omb_sess_file_value")).toBe("file");
    const file = join(home, "linux", ".config", "openmausbot", "sessions", "box");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(saved.token("box")).toBe("omb_sess_file_value");
    expect(saved.at("https://maus.example.com")?.name).toBe("box");
    expect(saved.at("https://maus.example.com.evil.test")).toBeNull();
  });

  it("sends a saved session only to the exact address it was made at, and never from a bot's shell", async () => {
    const keychain = fakeKeychain();
    const env = { HOME: join(home, "send") };
    const saved = new SavedServers({ env, platform: "darwin", security: keychain.runner });
    saved.save("local", server, "omb_sess_saved");
    const request = vi.fn(async () => ({}));
    const headers = () => (request.mock.calls.at(-1) as unknown as [string, RequestInit, string]);

    const current = await openClient({}, { env, request, saved }, true);
    expect(current).toMatchObject({ baseUrl: server.url, explicit: true, identity: { kind: "saved", name: "local" } });
    await current.json("/api/bots");
    expect(new Headers(headers()[1].headers).get("authorization")).toBe("Bearer omb_sess_saved");

    const elsewhere = await openClient({ url: "http://127.0.0.1:18799" }, { env, request, saved }, true);
    await elsewhere.json("/api/bots");
    expect(elsewhere.identity).toEqual({ kind: "none" });
    expect(new Headers(headers()[1].headers).has("authorization")).toBe(false);

    const named = await openClient({ port: "8799" }, { env, request, saved }, true);
    expect(named.identity).toMatchObject({ kind: "saved" });

    // In a bot's shell main.ts passes no saved servers at all, so the person's session is never read.
    expect(inBotShell({ OMB_DESKTOP_PARENT: "1" })).toBe(true);
    expect(inBotShell({ OMB_HOOK_TOKEN_FILE: "/tmp/x" })).toBe(true);
    expect(inBotShell({ OMB_COMMS_TOKEN: "t" })).toBe(true);
    expect(inBotShell({ OMB_ENGINE_TAG: "0123456789abcdef0123456789abcdef" })).toBe(true);
    expect(inBotShell({ HOME: "/h", OMB_PORT: "8799", OMB_DATA_DIR: "/d" })).toBe(false);
  });
});

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createDesktopComputer, DESKTOP_COMPUTER_GRANT, thisComputerNotReady } from "./desktop-computer.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const READY = { mode: "embedded", status: "ready", socketPath: "/fixture/cua.sock", mcpCommand: "/fixture/cua-driver", mcpArgs: ["mcp"], mcpEnv: {} };
const saved = { userData: process.env.OMB_USER_DATA, parent: process.env.OMB_DESKTOP_PARENT, home: process.env.HOME };
const folders: string[] = [];

afterEach(() => {
  for (const [key, value] of [["OMB_USER_DATA", saved.userData], ["OMB_DESKTOP_PARENT", saved.parent], ["HOME", saved.home]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("this computer, only for the desktop app's own server", () => {
  it("finds nothing on a server the app did not launch, though the app's record, its folder and the desktop flag are all there", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-desktop-computer-"));
    folders.push(home);
    for (const folder of [join(home, "user-data"), join(home, "Library", "Application Support", "OpenMausBot")]) {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      writeFileSync(join(folder, "cua-connection.json"), JSON.stringify(READY), { mode: 0o600 });
    }
    Object.assign(process.env, { OMB_USER_DATA: join(home, "user-data"), OMB_DESKTOP_PARENT: "1", HOME: home });
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const desktop = createDesktopComputer({ platform });
      expect(desktop.connection(), platform).toBeNull();
      expect(desktop.granted(), platform).toBe(false);
      expect(desktop.unavailableReason(), platform).toBeNull();
    }
    expect(thisComputerNotReady(createDesktopComputer())).toBe(
      "Only the OpenMausBot app on this computer can let a bot use it. Open the app here, or let the bot work in its own browser or on a cloud desktop instead.",
    );
  });

  it("uses the connection the app hands over, and follows each change it sends", () => {
    const desktop = createDesktopComputer({ platform: "darwin" });
    expect(desktop.receive({ type: DESKTOP_COMPUTER_GRANT, connection: READY })).toBe(true);
    expect(desktop.connection()).toEqual({ command: "/fixture/cua-driver", args: ["mcp"], env: {}, platform: "darwin", scope: "local-computer" });
    const reason = "embedded host failed: Screen Recording required; grant access in System Settings and restart OpenMausBot";
    expect(desktop.receive({ type: DESKTOP_COMPUTER_GRANT, connection: { mode: "unavailable", reason } })).toBe(true);
    expect(desktop.connection()).toBeNull();
    expect(desktop.unavailableReason()).toBe(reason);
    expect(thisComputerNotReady(desktop, "darwin")).toBe(
      `OpenMausBot can't use this computer yet — ${reason}. Relaunch OpenMausBot after granting the missing macOS permission.`,
    );
    expect(desktop.receive({ type: DESKTOP_COMPUTER_GRANT, connection: null })).toBe(true);
    expect(desktop.connection()).toBeNull();
    expect(desktop.granted()).toBe(true);
    expect(thisComputerNotReady(desktop)).toBe("OpenMausBot can't use this computer yet — make sure OpenMausBot has the permissions it asks for, then restart it");
  });

  it("decodes again on every use, so a Linux driver that stopped is no longer used", () => {
    let alive = true;
    const desktop = createDesktopComputer({ platform: "linux", decode: (raw) => (alive ? { command: "/d", args: [], env: {}, platform: "linux", scope: "local-computer", raw } as never : null) });
    desktop.receive({ type: DESKTOP_COMPUTER_GRANT, connection: { any: "record" } });
    expect(desktop.connection()).not.toBeNull();
    alive = false;
    expect(desktop.connection()).toBeNull();
  });

  it("ignores every other parent message and refuses a malformed grant", () => {
    const desktop = createDesktopComputer({ platform: "darwin" });
    for (const message of [null, "x", [], { type: "openmausbot:desktop-mutation-token", token: "t" }, { connection: READY }]) {
      expect(desktop.receive(message)).toBe(false);
    }
    expect(() => desktop.receive({ type: DESKTOP_COMPUTER_GRANT, connection: "/path/to/cua-connection.json" })).toThrow();
    expect(() => desktop.receive({ type: DESKTOP_COMPUTER_GRANT, connection: [READY] })).toThrow();
    expect(desktop.granted()).toBe(false);
  });

  // The guarantee is the one door: a grant is read only from the parent port, and no server code reads the app's record.
  it("is fed only from Electron's private parent port, and no server code reads the app's record file", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === "testing" || name === "node_modules") continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) sources.push(path);
      }
    };
    walk(join(ROOT, "server"));
    const uses = (needle: string) => sources.filter((path) => readFileSync(path, "utf8").includes(needle))
      .map((path) => relative(ROOT, path).split(sep).join("/"));
    expect(uses("desktopComputer.receive(")).toEqual(["server/index.ts"]);
    const index = readFileSync(join(ROOT, "server/index.ts"), "utf8");
    const listener = index.slice(index.indexOf("utilityParentPort?.on(\"message\""), index.indexOf("const quickFallback"));
    expect(listener).toContain("desktopComputer.receive(message)");
    expect(index.split("desktopComputer.receive(").length - 1).toBe(1);
    expect(uses("readCuaConnection(")).toEqual(["server/local-computer.ts"]);
    expect(uses("cua-connection.json")).toEqual(["server/local-computer.ts"]);
  });
});

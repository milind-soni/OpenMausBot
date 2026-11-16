import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { listsComputerTool } from "./computer-tool-list.ts";
import { withHostFileTools } from "./drivers/chat-mcp-tools.ts";
import { HOST_FILE_READ_LIMIT, HOST_FILE_TOOLS, HOST_FILE_WRITE_LIMIT, hostFileRelay, placeNew } from "./host-file-tools.ts";
import { withHostFiles } from "./local-computer.ts";

describe("the bridge's switch", () => {
  it("turns on only for this desktop's own gated computer", () => {
    const gated = { command: "node", args: [], env: { OMB_CUA_COMMAND: "cua-driver" } as Record<string, string>, platform: "win32" as const, scope: "local-computer" as const };
    expect(withHostFiles(gated).env.OMB_HOST_FILES).toBe("1");
    const vm = { command: "node", args: [], env: {}, platform: "linux" as const };
    expect(withHostFiles(vm)).toBe(vm);
    expect(withHostFiles({ ...gated, env: {} }).env).toEqual({});
    const turn = withHostFileTools({ localComputer: gated, agents: { command: "agents", args: [], env: {} } });
    expect(turn?.localComputer?.env.OMB_HOST_FILES).toBe("1");
    expect(turn?.agents).toEqual({ command: "agents", args: [], env: {} });
    const none = { agents: { command: "agents", args: [], env: {} } };
    expect(withHostFileTools(none)).toBe(none);
  });

  it("lists the file tools to a chat bot beside the screen tools, the built-in browser too", () => {
    for (const tool of HOST_FILE_TOOLS) expect(listsComputerTool(tool.name, true), tool.name).toBe(true);
  });
});

describe("file tools on disk", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const fixture = () => {
    // Native, as the tools resolve: on Windows it also spells out a short (8.3) temp folder name such as RUNNER~1.
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "omb-host-files-")));
    made.push(root);
    const home = join(root, "home");
    mkdirSync(join(home, "Documents"), { recursive: true });
    mkdirSync(join(root, "outside"));
    const relay = hostFileRelay(home);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await relay({ name, arguments: args })!;
      return { text: result.content.map((part) => part.text).join("\n"), error: result.isError === true };
    };
    return { root, home, call };
  };

  it("answers only its own four tools", () => {
    expect(hostFileRelay("/")({ name: "screenshot", arguments: {} })).toBeNull();
  });

  it("reads and saves on any full path: hidden folders, outside home, scripts and programs included", async () => {
    const { root, home, call } = fixture();
    const posix = process.platform !== "win32";
    for (const target of [join(home, "Projects", "site", ".git", "hooks", "pre-commit"), join(home, ".ssh", "config"), join(root, "outside", "run.bat"),
      join(home, "Library", "x.txt"), join(home, "AppData", "Roaming", "x.ps1"), join(home, "Documents", "WindowsPowerShell", "profile.ps1"),
      join(home, "Applications", "Thing.app", "Contents", "Info.plist"), join(home, "Desktop", "launch.desktop"), join(home, "snap", "x", "a.txt")]) {
      expect(await call("write_file", { path: target, content: "x" }), target).toEqual({ text: `Saved 1 bytes to ${target}.`, error: false });
      expect(await call("read_file", { path: target })).toEqual({ text: `${target} (1 bytes):\nx`, error: false });
    }
    if (posix) {
      writeFileSync(join(home, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
      expect((await call("write_file", { path: join(home, "run.sh"), content: "#!/bin/sh\necho new\n", overwrite: true })).error).toBe(false);
      expect(readFileSync(join(home, "run.sh"), "utf8")).toBe("#!/bin/sh\necho new\n");
      expect(statSync(join(home, "run.sh")).mode & 0o777).toBe(0o755);
    }
    expect(await call("make_folder", { path: join(home, ".config", "tool") })).toEqual({ text: `Made the folder ${join(home, ".config", "tool")}.`, error: false });
    expect(await call("make_folder", { path: join(home, ".config", "tool") })).toEqual({ text: `${join(home, ".config", "tool")} is already there.`, error: false });
    expect((await call("write_file", { path: "~/Documents/a.md", content: "a" })).text).toBe(`Saved 1 bytes to ${join(home, "Documents", "a.md")}.`);
  });

  it.skipIf(process.platform === "win32")("follows links and reports the real path", async () => {
    const { root, home, call } = fixture();
    writeFileSync(join(root, "outside", "secret.txt"), "outside");
    symlinkSync(join(root, "outside"), join(home, "Documents", "elsewhere"));
    symlinkSync(join(root, "outside", "secret.txt"), join(home, "Documents", "key.txt"));
    const real = join(root, "outside", "secret.txt");
    expect(await call("read_file", { path: join(home, "Documents", "key.txt") })).toEqual({ text: `${real} (7 bytes):\noutside`, error: false });
    expect(await call("read_file", { path: join(home, "Documents", "elsewhere", "secret.txt") })).toEqual({ text: `${real} (7 bytes):\noutside`, error: false });
    expect((await call("write_file", { path: join(home, "Documents", "key.txt"), content: "new" })).text).toMatch(/already exists.*overwrite: true/);
    expect(await call("write_file", { path: join(home, "Documents", "key.txt"), content: "new", overwrite: true }))
      .toEqual({ text: `Saved 3 bytes to ${real} (replaced the file that was there).`, error: false });
    expect(readFileSync(real, "utf8")).toBe("new");
    expect(await call("write_file", { path: join(home, "Documents", "elsewhere", "b.txt"), content: "b" }))
      .toEqual({ text: `Saved 1 bytes to ${join(root, "outside", "b.txt")}.`, error: false });
    expect((await call("list_files", { path: join(home, "Documents") })).text.split("\n")).toEqual(expect.arrayContaining(["link    elsewhere", "link    key.txt"]));
  });

  it("keeps the overwrite flag, the size caps and full paths, and passes the OS's own errors on", async () => {
    const { home, call } = fixture();
    const target = join(home, "Documents", "a.txt");
    expect((await call("write_file", { path: target, content: "one" })).error).toBe(false);
    const again = await call("write_file", { path: target, content: "two" });
    expect(again).toEqual({ text: `${target} already exists. To replace it, call write_file again with overwrite: true.`, error: true });
    expect(readFileSync(target, "utf8")).toBe("one");
    expect((await call("write_file", { path: target, content: "two", overwrite: true })).error).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("two");
    expect(readdirSync(join(home, "Documents"))).toEqual(["a.txt"]);

    writeFileSync(join(home, "big.bin"), Buffer.alloc(HOST_FILE_READ_LIMIT + 1));
    expect((await call("read_file", { path: join(home, "big.bin") })).text).toMatch(/files up to 10 MB can be read/);
    expect(await call("write_file", { path: join(home, "huge.txt"), content: "x".repeat(HOST_FILE_WRITE_LIMIT + 1) })).toEqual({ text: "Files up to 25 MB can be saved.", error: true });
    expect(existsSync(join(home, "huge.txt"))).toBe(false);

    expect((await call("write_file", { path: "notes.txt", content: "x" })).text).toMatch(/full path/);
    expect((await call("read_file", { path: join(home, "missing.txt") })).text).toMatch(/ENOENT: no such file or directory/);
    expect((await call("write_file", { path: join(home, "Documents"), content: "x", overwrite: true })).text).toMatch(/is a folder/);
    expect((await call("make_folder", { path: target })).text).toBe(`${target} is a file, not a folder.`);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      mkdirSync(join(home, "locked"));
      chmodSync(join(home, "locked"), 0o500);
      expect((await call("write_file", { path: join(home, "locked", "a.txt"), content: "x" })).text).toMatch(/EACCES: permission denied/);
      chmodSync(join(home, "locked"), 0o700);
    }
  });

  it("lists the home folder when given no path", async () => {
    const { home, call } = fixture();
    expect(await call("list_files")).toEqual({ text: `${home}\nfolder  Documents`, error: false });
  });

  it("puts a new file in place only while nothing is there, with or without links, and never overwrites what appeared", async () => {
    const { home } = fixture();
    const temp = join(home, "Documents", ".a.txt.tmp");
    const target = join(home, "Documents", "a.txt");
    writeFileSync(temp, "new");
    await placeNew(temp, target);
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(existsSync(temp)).toBe(false);

    const reason = (promise: Promise<unknown>) => promise.then(() => null, (error: Error) => error.message);
    writeFileSync(temp, "late");
    expect(await reason(placeNew(temp, target))).toMatch(/already exists.*overwrite: true/);
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(existsSync(temp)).toBe(false);

    const noLinks = async () => { throw Object.assign(new Error("links not supported"), { code: "EPERM" }); };
    writeFileSync(temp, "copied");
    await placeNew(temp, join(home, "Documents", "b.txt"), noLinks);
    expect(readFileSync(join(home, "Documents", "b.txt"), "utf8")).toBe("copied");
    writeFileSync(temp, "late");
    expect(await reason(placeNew(temp, join(home, "Documents", "b.txt"), noLinks))).toMatch(/already exists/);
    expect(readFileSync(join(home, "Documents", "b.txt"), "utf8")).toBe("copied");
    expect(existsSync(temp)).toBe(false);
  });
});

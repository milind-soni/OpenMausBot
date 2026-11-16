import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  OUTSIDE,
  hostFilesSetting,
  hostFolders,
  knownFolders,
  placeOf,
  refusalFor,
  resolveHostPath,
  windowsFoldersFrom,
  writeRefusal,
  type HostFolders,
} from "./host-files.ts";
import { listsComputerTool } from "./computer-tool-list.ts";
import { withHostFileTools } from "./drivers/chat-mcp-tools.ts";
import { HOST_FILE_TOOLS, placeNew } from "./host-file-tools.ts";
import { withHostFiles } from "./local-computer.ts";

const WINDOWS: HostFolders = {
  platform: "win32",
  places: [
    { name: "Home", path: "C:\\Users\\ana", given: "C:\\Users\\ana" },
    { name: "Documents", path: "C:\\Users\\ana\\OneDrive\\Documentos", given: "C:\\Users\\ana\\OneDrive\\Documentos" },
    { name: "Desktop", path: "D:\\Mesa", given: "D:\\Mesa" },
  ],
  denied: ["E:\\OpenMausBotData"],
  programs: ["C:\\Users\\ana\\AppData\\Local\\Microsoft\\WindowsApps", "C:\\Users\\ana\\bin"],
};

const MAC: HostFolders = {
  platform: "darwin",
  places: [{ name: "Home", path: "/Users/ana", given: "/Users/ana" }],
  denied: [],
  programs: ["/Users/ana/.local/bin", "/Users/ana/tools"],
};

const LINUX: HostFolders = { platform: "linux", places: [{ name: "Home", path: "/home/ana", given: "/home/ana" }], denied: [], programs: [] };

const refusal = (folders: HostFolders, raw: unknown) => {
  try {
    placeOf(folders, raw);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};

describe("which paths a bot may name on Windows", () => {
  it("finds the redirected Documents folder, however the bot spells it", () => {
    expect(placeOf(WINDOWS, "C:\\Users\\ana\\OneDrive\\Documentos\\My Agents\\Vendas\\resumo.md"))
      .toEqual({ place: WINDOWS.places[1], parts: ["My Agents", "Vendas", "resumo.md"] });
    expect(placeOf(WINDOWS, "c:/users/ANA/onedrive/documentos/a.txt")).toMatchObject({ place: { name: "Documents" }, parts: ["a.txt"] });
    expect(placeOf(WINDOWS, "D:\\Mesa\\x.txt")).toMatchObject({ place: { name: "Desktop" }, parts: ["x.txt"] });
    expect(placeOf(WINDOWS, "~\\notes.txt")).toMatchObject({ place: { name: "Home" }, parts: ["notes.txt"] });
  });

  it("refuses network, device and relative paths, other accounts, the system and odd names", () => {
    for (const raw of ["\\\\server\\share\\a.txt", "\\\\?\\C:\\Users\\ana\\a.txt", "\\\\.\\PhysicalDrive0", "C:relative.txt", "Documents\\a.txt", "/Users/ana/a.txt"]) {
      expect(refusal(WINDOWS, raw), raw).toMatch(/drive letter/);
    }
    expect(refusal(WINDOWS, "C:\\Users\\ana\\a.txt:hidden")).toMatch(/':'/);
    for (const raw of ["C:\\Users\\bob\\Documents\\a.txt", "C:\\Users\\ana\\..\\bob\\a.txt", "C:\\Windows\\System32\\drivers\\etc\\hosts", "C:\\Users", "D:\\Other\\a.txt"]) {
      expect(refusal(WINDOWS, raw), raw).toBe(OUTSIDE);
    }
    for (const raw of ["C:\\Users\\ana\\CON", "C:\\Users\\ana\\nul.txt", "C:\\Users\\ana\\a.txt.", "C:\\Users\\ana\\a<b.txt", "C:\\Users\\ana\\x\u0007y"]) {
      expect(refusal(WINDOWS, raw), raw).toMatch(/cannot have/);
    }
    expect(refusal(WINDOWS, 42)).toMatch(/full path/);
    expect(refusal(WINDOWS, "")).toMatch(/full path/);
  });

  it("keeps settings, keys, app data and PowerShell profiles closed inside allowed folders", () => {
    for (const target of ["C:\\Users\\ana\\AppData\\Roaming\\Microsoft\\Credentials\\x", "C:\\Users\\ana\\appdata\\Local\\Google\\Chrome\\User Data",
      "C:\\Users\\ana\\.ssh\\id_ed25519", "C:\\Users\\ana\\.openmausbot\\config.json", "C:\\Users\\ana\\OneDrive\\Documentos\\WindowsPowerShell\\profile.ps1"]) {
      expect(refusalFor(WINDOWS, target), target).toMatch(/settings, keys or app data/);
    }
    expect(refusalFor(WINDOWS, "C:\\Users\\ana\\OneDrive\\Documentos\\My Agents\\a.md")).toBeNull();
    expect(refusalFor(WINDOWS, "C:\\Users\\ana\\Downloads\\a.zip")).toBeNull();
    expect(refusalFor(WINDOWS, "E:\\OpenMausBotData\\x")).toBe(OUTSIDE);
  });

  it("reads Windows' own answer for its folders, OneDrive's move included, and only drive paths", () => {
    const answer = "\uFEFF" + JSON.stringify({
      Desktop: "C:\\Users\\ana\\OneDrive\\Área de Trabalho", MyDocuments: "C:\\Users\\ana\\OneDrive\\Documentos",
      Downloads: "C:\\Users\\ana\\Downloads", MyPictures: "\\\\server\\pics", MyMusic: "", Other: "C:\\x",
    });
    expect(windowsFoldersFrom(answer)).toEqual([
      { name: "Desktop", path: "C:\\Users\\ana\\OneDrive\\Área de Trabalho" },
      { name: "Documents", path: "C:\\Users\\ana\\OneDrive\\Documentos" },
      { name: "Downloads", path: "C:\\Users\\ana\\Downloads" },
    ]);
    expect(windowsFoldersFrom("not json")).toEqual([]);
  });

  it("asks PowerShell by its full path with a time limit, and falls back to the usual folders when it fails", async () => {
    const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
    const env = { SystemRoot: "C:\\WINDOWS", OneDrive: "C:\\Users\\ana\\OneDrive", OneDriveCommercial: "relative" };
    const asked = await knownFolders("win32", "C:\\Users\\ana", env, async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return JSON.stringify({ MyDocuments: "C:\\Users\\ana\\OneDrive\\Documentos" });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(calls[0]!.args).toContain("-EncodedCommand");
    expect(calls[0]!.timeoutMs).toBeGreaterThan(0);
    expect(Buffer.from(calls[0]!.args.at(-1)!, "base64").toString("utf16le")).toContain("GetFolderPath");
    expect(asked[0]).toEqual({ name: "Documents", path: "C:\\Users\\ana\\OneDrive\\Documentos" });
    expect(asked).toContainEqual({ name: "OneDrive", path: "C:\\Users\\ana\\OneDrive" });
    const fallback = await knownFolders("win32", "C:\\Users\\ana", { SystemRoot: "..\\evil" }, async (file) => {
      expect(file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      throw new Error("timed out");
    });
    expect(fallback.map((entry) => entry.path)).toEqual(["C:\\Users\\ana\\Desktop", "C:\\Users\\ana\\Documents", "C:\\Users\\ana\\Downloads"]);
  });
});

describe("what stays closed at any depth, and what is never saved", () => {
  it("refuses hidden folders and files anywhere, PowerShell's folders anywhere, and ~/snap on Linux, for reads and writes", () => {
    for (const target of ["/Users/ana/Projects/site/.git/hooks/pre-commit", "/Users/ana/Projects/site/.git/config", "/Users/ana/Documents/app/.env",
      "/Users/ana/Projects/x/.vscode/settings.json", "/Users/ana/Projects/x/.husky/pre-push", "/Users/ana/Projects/x/.github/workflows/ci.yml",
      "/Users/ana/Projects/x/node_modules/.bin/vite", "/Users/ana/Documents/PowerShell/profile.ps1", "/Users/ana/Projects/x/windowspowershell/a.txt"]) {
      expect(refusalFor(MAC, target), target).toMatch(/settings, keys or app data/);
    }
    for (const target of ["C:\\Users\\ana\\Projetos\\WindowsPowerShell\\x.txt", "D:\\Mesa\\PowerShell\\Modules\\a.psm1", "C:\\Users\\ana\\OneDrive\\Documentos\\windowspowershell\\Microsoft.PowerShell_profile.ps1"]) {
      expect(refusalFor(WINDOWS, target), target).toMatch(/settings, keys or app data/);
    }
    expect(refusalFor(LINUX, "/home/ana/snap/firefox/common/.mozilla/x")).toMatch(/settings, keys or app data/);
    expect(refusalFor(LINUX, "/home/ana/Documents/snap/notes.txt")).toBeNull();
    expect(refusalFor(MAC, "/Users/ana/snap/notes.txt")).toBeNull();
    expect(refusalFor(MAC, "/Users/ana/Projects/site/index.html")).toBeNull();
  });

  it("never saves a file type the system runs, nor anything in an app bundle or a folder on PATH", () => {
    for (const name of ["run.bat", "RUN.CMD", "a.vbs", "a.vbe", "a.js", "a.jse", "a.wsf", "a.wsh", "a.hta", "setup.exe", "a.scr", "a.com", "a.pif", "a.msi",
      "a.dll", "a.Ps1", "a.psm1", "Atalho.lnk", "a.url", "a.scf", "a.library-ms", "a.searchConnector-ms", "desktop.ini", "Desktop.INI"]) {
      expect(writeRefusal(WINDOWS, `C:\\Users\\ana\\OneDrive\\Documentos\\${name}`), name).toMatch(/runs as a program/);
    }
    for (const name of ["notes.txt", "resumo.md", "contrato.docx", "a.pdf", "dados.csv", "foto.png", "planilha.xlsx"]) {
      expect(writeRefusal(WINDOWS, `C:\\Users\\ana\\OneDrive\\Documentos\\${name}`), name).toBeNull();
      expect(writeRefusal(MAC, `/Users/ana/Documents/${name}`), name).toBeNull();
      expect(writeRefusal(LINUX, `/home/ana/Documents/${name}`), name).toBeNull();
    }
    for (const name of ["go.command", "a.terminal", "x.tool", "Do It.workflow", "Thing.app"]) {
      expect(writeRefusal(MAC, `/Users/ana/Desktop/${name}`), name).toMatch(/runs as a program/);
    }
    expect(writeRefusal(MAC, "/Users/ana/Applications/Thing.app/Contents/MacOS/Thing")).toMatch(/runs as a program/);
    expect(writeRefusal(MAC, "/Users/ana/Applications/Thing.APP/Contents/Info.plist")).toMatch(/runs as a program/);
    expect(writeRefusal(MAC, "/Users/ana/Projects/Thing.app", "folder")).toMatch(/runs as a program/);
    expect(writeRefusal(MAC, "/Users/ana/Projects/new", "folder")).toBeNull();
    expect(writeRefusal(LINUX, "/home/ana/Desktop/launch.desktop")).toMatch(/runs as a program/);
    expect(writeRefusal(LINUX, "/home/ana/Desktop/run.bat")).toBeNull();
    expect(writeRefusal(MAC, "/Users/ana/tools/ls")).toMatch(/runs as a program/);
    expect(writeRefusal(MAC, "/Users/ana/tools/sub/notes.txt")).toBeNull();
    expect(writeRefusal(WINDOWS, "c:\\users\\ana\\BIN\\git.txt")).toMatch(/runs as a program/);
  });
});

describe("the bridge's switch", () => {
  it("turns on only for this desktop's own gated computer, carrying the app's data folder", () => {
    const gated = { command: "node", args: [], env: { OMB_CUA_COMMAND: "cua-driver" } as Record<string, string>, platform: "win32" as const, scope: "local-computer" as const };
    const on = withHostFiles(gated, ["C:\\Users\\ana\\.openmausbot"]);
    expect(hostFilesSetting(on.env.OMB_HOST_FILES, "win32")).toEqual({ platform: "win32", appData: ["C:\\Users\\ana\\.openmausbot"] });
    const vm = { command: "node", args: [], env: {}, platform: "linux" as const };
    expect(withHostFiles(vm, [])).toBe(vm);
    expect(withHostFiles({ ...gated, env: {} }, []).env).toEqual({});
    expect(hostFilesSetting(undefined, "darwin")).toBeNull();
    expect(hostFilesSetting('{"appData":["/x"]}', "freebsd")).toBeNull();
    expect(hostFilesSetting('{"appData":[1]}', "darwin")).toBeNull();
    expect(hostFilesSetting("{", "darwin")).toBeNull();
    const turn = withHostFileTools({ localComputer: gated, agents: { command: "agents", args: [], env: {} } });
    expect(hostFilesSetting(turn?.localComputer?.env.OMB_HOST_FILES, "win32")?.appData).toHaveLength(1);
    expect(turn?.agents).toEqual({ command: "agents", args: [], env: {} });
    const none = { agents: { command: "agents", args: [], env: {} } };
    expect(withHostFileTools(none)).toBe(none);
  });

  it("lists the file tools to a chat bot beside the screen tools, the built-in browser too", () => {
    for (const tool of HOST_FILE_TOOLS) expect(listsComputerTool(tool.name, true), tool.name).toBe(true);
  });
});

describe("paths on disk", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const posix = process.platform === "win32" ? null : (process.platform as "darwin" | "linux");
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "omb-host-files-"));
    made.push(root);
    const home = join(root, "home");
    const outside = join(root, "outside");
    for (const dir of ["Documents", "Desktop", ".ssh", "Library/Keychains", "Library/Mobile Documents/com~apple~CloudDocs", ".openmausbot"]) mkdirSync(join(home, dir), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "outside");
    writeFileSync(join(home, ".ssh", "id_ed25519"), "key");
    return { root, home, outside };
  };
  const reason = (promise: Promise<unknown>) => promise.then(() => null, (error: Error) => error.message);

  it.skipIf(!posix)("finds the person's folders, with an XDG redirect, and leaves out folders outside home", async () => {
    const { home, outside } = fixture();
    mkdirSync(join(home, "Dokumente"));
    mkdirSync(join(home, ".config"), { recursive: true });
    writeFileSync(join(home, ".config", "user-dirs.dirs"), `XDG_DOCUMENTS_DIR="$HOME/Dokumente"\nXDG_DESKTOP_DIR="${outside}"\nXDG_DOWNLOAD_DIR="$HOME/$(rm -rf x)"\n`);
    const folders = await hostFolders({ platform: "linux", home, env: {}, appData: [join(home, ".openmausbot")] });
    const real = realpathSync(home);
    expect(folders.places.map((place) => [place.name, place.path])).toEqual([
      ["Home", real], ["Documents", join(real, "Dokumente")], ["Desktop", join(real, "Desktop")],
    ]);
    expect(folders.denied).toContain(join(real, ".openmausbot"));
  });

  it.skipIf(!posix)("resolves real paths, refuses links out (or anywhere) and closed folders", async () => {
    const { home, outside, root } = fixture();
    symlinkSync(outside, join(home, "Documents", "escape"));
    symlinkSync(join(home, "Desktop"), join(home, "Documents", "inside-link"));
    symlinkSync(join(home, ".ssh", "id_ed25519"), join(home, "Documents", "key.txt"));
    symlinkSync(join(home, "Documents"), join(root, "home-link"));
    const folders = await hostFolders({ platform: posix!, home, env: {}, appData: [join(home, ".openmausbot")] });
    const real = realpathSync(home);

    expect(await resolveHostPath(folders, join(home, "Documents", "My Agents", "x", "a.md")))
      .toEqual({ target: join(real, "Documents", "My Agents", "x", "a.md"), exists: false });
    expect(await resolveHostPath(folders, "~/Documents")).toEqual({ target: join(real, "Documents"), exists: true });
    expect(await resolveHostPath(folders, join(real, "Desktop"))).toEqual({ target: join(real, "Desktop"), exists: true });

    for (const raw of [join(home, "Documents", "escape", "secret.txt"), join(home, "Documents", "inside-link", "a.txt"), join(home, "Documents", "key.txt")]) {
      expect(await reason(resolveHostPath(folders, raw)), raw).toMatch(/link or shortcut/);
    }
    expect(await reason(resolveHostPath(folders, join(root, "home-link", "a.txt")))).toBe(OUTSIDE);
    expect(await reason(resolveHostPath(folders, join(outside, "secret.txt")))).toBe(OUTSIDE);
    expect(await reason(resolveHostPath(folders, join(home, "Documents", "..", "..", "outside", "secret.txt")))).toBe(OUTSIDE);
    for (const raw of [join(home, ".ssh", "id_ed25519"), join(home, ".openmausbot", "config.json"), join(home, "Library", "Keychains", "login.keychain-db")]) {
      expect(await reason(resolveHostPath(folders, raw)), raw).toMatch(/settings, keys or app data/);
    }
    expect(await reason(resolveHostPath(folders, "Documents/a.txt"))).toMatch(/starts with \//);
  });

  it("puts a new file in place only while nothing is there, with or without links, and never overwrites what appeared", async () => {
    const { home } = fixture();
    const temp = join(home, "Documents", ".a.txt.tmp");
    const target = join(home, "Documents", "a.txt");
    writeFileSync(temp, "new");
    await placeNew(temp, target);
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(existsSync(temp)).toBe(false);

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

  it.skipIf(!posix)("knows the folders on PATH by their real paths", async () => {
    const { home, root } = fixture();
    mkdirSync(join(home, "bin"));
    symlinkSync(join(home, "bin"), join(root, "bin-link"));
    const folders = await hostFolders({ platform: posix!, home, env: { PATH: `${join(root, "bin-link")}:relative/bin:` }, appData: [] });
    expect(folders.programs).toEqual([join(root, "bin-link"), join(realpathSync(home), "bin")]);
    expect(writeRefusal(folders, join(realpathSync(home), "bin", "tool"))).toMatch(/runs as a program/);
  });

  it.skipIf(process.platform !== "darwin")("opens iCloud Drive inside Library on macOS, and nothing else there", async () => {
    const { home } = fixture();
    const folders = await hostFolders({ platform: "darwin", home, env: {}, appData: [] });
    const real = realpathSync(home);
    expect(folders.places.find((place) => place.name === "iCloud Drive")?.path).toBe(join(real, "Library", "Mobile Documents", "com~apple~CloudDocs"));
    expect((await resolveHostPath(folders, join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "a.txt"))).exists).toBe(false);
    expect(await reason(resolveHostPath(folders, join(home, "library", "Keychains", "x")))).toMatch(/settings, keys or app data/);
    expect(await reason(resolveHostPath(folders, join(home.toUpperCase(), ".SSH", "id_ed25519")))).toMatch(/settings, keys or app data/);
  });
});

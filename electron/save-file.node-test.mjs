import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { collisionFreeDownloadPath, defaultSaveName, htmlCopyName, openFolder, openHtmlCopy, openLogsFolder, resolveSavablePath, revealDownloadWhenDone, revealInFolder, withSavableFile } from "./save-file.mjs";

// Creating a symlink on Windows needs elevation or developer mode.
const canSymlink = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "omb-symlink-probe-"));
  try {
    fs.symlinkSync(probe, path.join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

let home;
let botHome;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "omb-save-file-"));
  botHome = path.join(home, ".openmausbot");
  fs.mkdirSync(path.join(botHome, "workspaces", "bot"), { recursive: true });
  fs.writeFileSync(path.join(botHome, "workspaces", "bot", "report.docx"), "docx");
  fs.writeFileSync(path.join(home, "secret.txt"), "private");
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("save-file path validation", () => {
  it("accepts a file inside the bot home, as a path or a file:// URL", async () => {
    const file = path.join(botHome, "workspaces", "bot", "report.docx");
    // fs.promises.realpath, as the module uses: on Windows the callback API leaves 8.3 short names that the promises API expands.
    const expected = await fs.promises.realpath(file);
    assert.equal(await resolveSavablePath(file, { home }), expected);
    assert.equal(await resolveSavablePath(pathToFileURL(file).href, { home }), expected);
  });

  it("accepts a file under a symlinked bot home", { skip: !canSymlink }, async () => {
    const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "omb-real-home-"));
    const linkedHome = fs.mkdtempSync(path.join(os.tmpdir(), "omb-linked-home-"));
    const realBotHome = path.join(realHome, "bot-data");
    fs.mkdirSync(realBotHome, { recursive: true });
    fs.writeFileSync(path.join(realBotHome, "report.docx"), "docx");
    fs.symlinkSync(realBotHome, path.join(linkedHome, ".openmausbot"));

    const viaLink = path.join(linkedHome, ".openmausbot", "report.docx");
    assert.equal(await resolveSavablePath(viaLink, { home: linkedHome }), await fs.promises.realpath(viaLink));

    fs.rmSync(realHome, { recursive: true, force: true });
    fs.rmSync(linkedHome, { recursive: true, force: true });
  });

  it("rejects paths outside the bot home, including via traversal", async () => {
    const rejected = "Only files created by your bots can be saved";
    await assert.rejects(resolveSavablePath(path.join(home, "secret.txt"), { home }), { message: rejected });
    await assert.rejects(resolveSavablePath(path.join(botHome, "..", "secret.txt"), { home }), { message: rejected });
  });

  it("rejects a symlink inside the bot home pointing outside it", { skip: !canSymlink }, async () => {
    const escape = path.join(botHome, "escape.txt");
    fs.symlinkSync(path.join(home, "secret.txt"), escape);
    await assert.rejects(resolveSavablePath(escape, { home }), {
      message: "Only files created by your bots can be saved",
    });
    fs.rmSync(escape);
  });

  it("rejects empty, relative, and non-file targets", async () => {
    await assert.rejects(resolveSavablePath("", { home }), { message: "A file path is required" });
    await assert.rejects(resolveSavablePath("workspaces/bot/report.docx", { home }), { message: "That file path is invalid" });
    await assert.rejects(resolveSavablePath(path.join(botHome, "nope.docx"), { home }), { message: "That file no longer exists" });
    await assert.rejects(resolveSavablePath(path.join(botHome, "workspaces"), { home }), { message: "That path is not a file" });
  });
});

describe("save-file dialog default name", () => {
  it("suggests a name that does not overwrite an existing file", async () => {
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "omb-downloads-"));
    const source = path.join(botHome, "workspaces", "bot", "report.docx");

    assert.equal(await defaultSaveName(downloads, source), path.join(downloads, "report.docx"));
    fs.writeFileSync(path.join(downloads, "report.docx"), "");
    assert.equal(await defaultSaveName(downloads, source), path.join(downloads, "report (2).docx"));
    fs.writeFileSync(path.join(downloads, "report (2).docx"), "");
    assert.equal(await defaultSaveName(downloads, source), path.join(downloads, "report (3).docx"));

    fs.rmSync(downloads, { recursive: true, force: true });
  });

  it("keeps the extension on the suggestion", async () => {
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "omb-downloads-ext-"));
    const source = path.join(botHome, "workspaces", "bot", "report.docx");
    fs.writeFileSync(path.join(downloads, "report.docx"), "");

    assert.equal(path.extname(await defaultSaveName(downloads, source)), ".docx");

    fs.rmSync(downloads, { recursive: true, force: true });
  });
});

describe("attachment download destination", () => {
  it("uses Chromium-style suffixes without replacing an existing download", () => {
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "omb-attachment-downloads-"));
    try {
      assert.equal(
        collisionFreeDownloadPath(downloads, "report.tar.gz"),
        path.join(downloads, "report.tar.gz"),
      );
      fs.writeFileSync(path.join(downloads, "report.tar.gz"), "first");
      assert.equal(
        collisionFreeDownloadPath(downloads, "report.tar.gz"),
        path.join(downloads, "report.tar (1).gz"),
      );
      fs.writeFileSync(path.join(downloads, "report.tar (1).gz"), "second");
      assert.equal(
        collisionFreeDownloadPath(downloads, "report.tar.gz"),
        path.join(downloads, "report.tar (2).gz"),
      );
    } finally {
      fs.rmSync(downloads, { recursive: true, force: true });
    }
  });

  it("keeps renderer-supplied directories outside the destination", () => {
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "omb-attachment-basename-"));
    try {
      assert.equal(
        collisionFreeDownloadPath(downloads, "../../outside.txt"),
        path.join(downloads, "outside.txt"),
      );
    } finally {
      fs.rmSync(downloads, { recursive: true, force: true });
    }
  });

  it("is installed on the default session before the primary window is created", () => {
    const main = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    const handler = main.indexOf('session.defaultSession.on("will-download"');
    assert.notEqual(handler, -1);
    assert.match(main.slice(handler), /item\.setSavePath\(collisionFreeDownloadPath\(/);
    assert.match(main.slice(handler), /revealDownloadWhenDone\(item, /);
    assert.ok(handler < main.indexOf("!deliveredCloudEntry) await showStartPlace();"));
  });

  it("reveals only a completed download at its actual save path", () => {
    const revealed = [];
    for (const state of ["completed", "cancelled", "interrupted"]) {
      const item = new EventEmitter();
      item.getSavePath = () => `/downloads/report-${state}.txt`;
      revealDownloadWhenDone(item, (filePath) => revealed.push(filePath));
      item.emit("done", {}, state);
    }
    assert.deepEqual(revealed, ["/downloads/report-completed.txt"]);
  });
});

describe("save-file source handles", () => {
  it("copies from the validated open handle", async () => {
    const source = path.join(botHome, "workspaces", "bot", "report.docx");
    const destination = path.join(home, "copied-report.docx");
    await withSavableFile(source, { home }, ({ copyTo }) => copyTo(destination));
    assert.equal(fs.readFileSync(destination, "utf8"), "docx");
    fs.rmSync(destination);
  });

  it("does not follow a symlink swap after the source is opened", { skip: !canSymlink || process.platform === "win32" }, async () => {
    const source = path.join(botHome, "workspaces", "bot", "report.docx");
    const moved = `${source}.moved`;
    const destination = path.join(home, "swapped-report.docx");
    await withSavableFile(source, { home }, async ({ copyTo }) => {
      fs.renameSync(source, moved);
      fs.symlinkSync(path.join(home, "secret.txt"), source);
      await copyTo(destination);
      assert.equal(fs.readFileSync(destination, "utf8"), "docx");
    }).finally(() => {
      if (fs.existsSync(source)) fs.rmSync(source);
      if (fs.existsSync(moved)) fs.renameSync(moved, source);
      if (fs.existsSync(destination)) fs.rmSync(destination);
    });
  });

  it("rejects a validation-to-open identity swap on Windows", async () => {
    const source = path.join(botHome, "workspaces", "bot", "report.docx");
    // Distinct BigInts that collapse to the same Number.
    const expected = { dev: 1n, ino: 9007199254740992n, isFile: () => true };
    const opened = { dev: 1n, ino: 9007199254740993n, isFile: () => true };
    let closed = false;
    let statOptions;
    let handleStatOptions;
    const fsp = {
      realpath: async (target) => target,
      stat: async (_target, options) => {
        statOptions = options;
        return expected;
      },
      open: async () => ({
        stat: async (options) => {
          handleStatOptions = options;
          return opened;
        },
        close: async () => {
          closed = true;
        },
      }),
    };

    await assert.rejects(
      withSavableFile(source, { home, fsp, platform: "win32" }, async () => {}),
      { message: "That file changed while it was being opened" },
    );
    assert.equal(closed, true);
    assert.deepEqual(statOptions, { bigint: true });
    assert.deepEqual(handleStatOptions, { bigint: true });
  });
});

describe("Show in folder for a file outside the workspace", () => {
  const shell = () => {
    const shown = [];
    return { shown, reveal: (target) => shown.push(target) };
  };

  it("reveals an existing file or folder by its normalised absolute path", async () => {
    const file = path.join(home, "secret.txt");
    const spelled = path.join(home, "workspace-elsewhere", "..", "secret.txt");
    const { shown, reveal } = shell();
    assert.equal(await revealInFolder(spelled, { reveal }), "shown");
    assert.equal(await revealInFolder(botHome, { reveal }), "shown");
    assert.deepEqual(shown, [file, botHome]);
  });

  it("says a missing file is missing and reveals nothing", async () => {
    const { shown, reveal } = shell();
    assert.equal(await revealInFolder(path.join(home, "gone.js"), { reveal }), "missing");
    assert.deepEqual(shown, []);
  });

  it("refuses relative paths, URLs and network shares without touching the disk", async () => {
    const { shown, reveal } = shell();
    const fsp = { stat: () => assert.fail("an invalid path must not be looked up") };
    for (const rawPath of ["secret.txt", "../secret.txt", pathToFileURL(path.join(home, "secret.txt")).href,
      "https://example.com/x", "//server/share/x", "", "\0", null, 42]) {
      assert.equal(await revealInFolder(rawPath, { reveal, fsp }), "invalid", String(rawPath));
    }
    for (const rawPath of ["\\\\server\\share\\x.js", "\\\\?\\C:\\x.js", "C:relative.js", "file:///C:/x.js"]) {
      assert.equal(await revealInFolder(rawPath, { reveal, fsp, pathApi: path.win32 }), "invalid", rawPath);
    }
    assert.deepEqual(shown, []);
  });

  it("accepts a Windows drive path like the one in the report", async () => {
    const { shown, reveal } = shell();
    const fsp = { stat: async () => ({ isFile: () => true, isDirectory: () => false }) };
    const rawPath = "C:\\Users\\Maus\\_draft\\..\\_draft\\ollama-gen.js";
    assert.equal(await revealInFolder(rawPath, { reveal, fsp, pathApi: path.win32 }), "shown");
    assert.deepEqual(shown, ["C:\\Users\\Maus\\_draft\\ollama-gen.js"]);
  });
});

describe("openFolder for a folder a chat links to", () => {
  const shell = (answer = "") => {
    const opened = [];
    return { opened, open: async (target) => { opened.push(target); return answer; } };
  };

  it("opens an existing folder by its normalised absolute path", async () => {
    const { opened, open } = shell();
    assert.equal(await openFolder(path.join(botHome, "..", path.basename(botHome)), { open }), "opened");
    assert.deepEqual(opened, [fs.realpathSync(botHome)]);
  });

  it("never opens a file (that would run it): the page keeps its save-a-copy", async () => {
    const { opened, open } = shell();
    assert.equal(await openFolder(path.join(home, "secret.txt"), { open }), "not-folder");
    assert.deepEqual(opened, []);
  });

  it("never opens a Mac app or other program folder, or a link to one", async () => {
    const { opened, open } = shell();
    const app = path.join(home, "Calculator.app");
    const bundle = path.join(home, "NoExtension");
    fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
    fs.mkdirSync(path.join(bundle, "Contents"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"), "");
    const link = path.join(home, "innocent-looking");
    fs.symlinkSync(app, link, process.platform === "win32" ? "junction" : "dir");
    for (const target of [app, bundle, link]) assert.equal(await openFolder(target, { open }), "not-folder", target);
    assert.deepEqual(opened, []);
  });

  it("says a missing folder is missing, and reports a failed open", async () => {
    const { opened, open } = shell();
    assert.equal(await openFolder(path.join(home, "gone"), { open }), "missing");
    assert.deepEqual(opened, []);
    assert.equal(await openFolder(botHome, { open: shell("no file manager").open }), "failed");
  });

  it("refuses relative paths, URLs and network shares without touching the disk", async () => {
    const { opened, open } = shell();
    const fsp = { stat: () => assert.fail("an invalid path must not be looked up") };
    for (const rawPath of ["notes", "../notes", "https://example.com/x", "//server/share/x", "", "\0", null, 42]) {
      assert.equal(await openFolder(rawPath, { open, fsp }), "invalid", String(rawPath));
    }
    for (const rawPath of ["\\\\server\\share\\x", "C:relative", "file:///C:/x"]) {
      assert.equal(await openFolder(rawPath, { open, fsp, pathApi: path.win32 }), "invalid", rawPath);
    }
    assert.deepEqual(opened, []);
  });

  it("opens a Windows folder path", async () => {
    const { opened, open } = shell();
    const fsp = {
      realpath: async (target) => target,
      stat: async (target) => {
        if (target.endsWith("Info.plist")) throw Object.assign(new Error("gone"), { code: "ENOENT" });
        return { isFile: () => false, isDirectory: () => true };
      },
    };
    assert.equal(await openFolder("C:\\Users\\Maus\\Reports\\..\\Reports", { open, fsp, pathApi: path.win32 }), "opened");
    assert.deepEqual(opened, ["C:\\Users\\Maus\\Reports"]);
  });

  it("gives up on a check that never answers (dead mount) and opens nothing when it answers late", async () => {
    const { opened, open } = shell();
    let answer;
    const fsp = {
      realpath: async (target) => target,
      stat: (target) => target.endsWith("Info.plist")
        ? new Promise((resolve, reject) => { answer = () => reject(Object.assign(new Error("gone"), { code: "ENOENT" })); })
        : Promise.resolve({ isFile: () => false, isDirectory: () => true }),
    };
    assert.equal(await openFolder("/Volumes/stale/Reports", { open, fsp, checkMs: 20 }), "not-folder");
    answer();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(opened, []);
  });
});

describe("openLogsFolder", () => {
  it("opens exactly main's own logs folder, making it first, and says where it is when the system cannot open it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omb-logs-folder-"));
    try {
      const folder = path.join(root, "OpenMausBot", "logs");
      const opened = [];
      assert.deepEqual(await openLogsFolder(folder, { open: async (target) => { opened.push(target); return ""; } }), { folder, opened: true });
      assert.deepEqual(opened, [folder]);
      assert.equal(fs.statSync(folder).isDirectory(), true);
      assert.deepEqual(await openLogsFolder(folder, { open: async () => "Failed to open path" }), { folder, opened: false, error: "Failed to open path" });
      assert.deepEqual(await openLogsFolder(folder, { open: async () => { throw new Error("no file manager"); } }), { folder, opened: false, error: "no file manager" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // The folder comes from main (app.getPath("logs")); the page asks with no path at all.
  it("is wired in main to its own logs folder, for this computer's page and My Cloud's once it is home", () => {
    const main = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    assert.match(main, /ipcMain\.handle\("desktop:open-logs", localOrHome\("desktop:open-logs", \(\) => openLogsFolder\(LOG_DIR, \{ open: \(folder\) => shell\.openPath\(folder\) \}\)\)\);/);
    assert.match(main, /const LOG_DIR = app\.getPath\("logs"\);/);
  });
});

describe("openHtmlCopy (#4406)", () => {
  it("opens a fresh private copy inside our own folder, never a path from the page", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omb-open-html-"));
    try {
      const opened = [];
      assert.equal(await openHtmlCopy("<h1>hi</h1>", "../../evil/report.html", { dir, open: async (file) => { opened.push(file); return ""; } }), true);
      assert.equal(opened.length, 1);
      assert.equal(path.dirname(path.dirname(opened[0])), dir);
      assert.equal(path.basename(opened[0]), "report.html");
      assert.equal(fs.readFileSync(opened[0], "utf8"), "\ufeff<h1>hi</h1>");
      if (process.platform !== "win32") assert.equal(fs.statSync(opened[0]).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses what is not a page or is too large, and passes on why the system could not open it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omb-open-html-"));
    try {
      const open = async () => "";
      await assert.rejects(openHtmlCopy(42, "a.html", { dir, open }), /Nothing to open/);
      await assert.rejects(openHtmlCopy("x".repeat(2 * 1024 * 1024 + 1), "a.html", { dir, open }), /too large/);
      await assert.rejects(openHtmlCopy("<p>", "a.html", { dir, open: async () => "No application" }), /No application/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears copies older than a day", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omb-open-html-"));
    try {
      const old = path.join(dir, "p-old");
      fs.mkdirSync(old);
      const day = Date.now() + 25 * 60 * 60 * 1000;
      await openHtmlCopy("<p>", "a.html", { dir, open: async () => "", now: day });
      assert.equal(fs.existsSync(old), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps only a safe file name with an HTML ending", () => {
    assert.equal(htmlCopyName("C:\\x\\Report.HTM"), "Report.htm");
    assert.equal(htmlCopyName("a<b>:c?.txt"), "abc.txt.html");
    assert.equal(htmlCopyName(".."), "page.html");
    assert.equal(htmlCopyName(undefined), "page.html");
    assert.deepEqual(["CON.html", "nul", "com1.report.htm", "Lpt9.HTML", "console.html"].map(htmlCopyName), ["_CON.html", "_nul.html", "_com1.report.htm", "_Lpt9.html", "console.html"]);
  });

  it("is wired in main for this computer's page only, with main's own temp folder", () => {
    const main = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    assert.match(main, /ipcMain\.handle\("desktop:open-html", localOnly\("desktop:open-html", \(_event, source, name\) =>\s*openHtmlCopy\(source, name, \{ dir: path\.join\(app\.getPath\("userData"\), "open-html"\)/);
  });
});

it("HTML validation uses the caller's translator before opening anything", async () => {
  const t = (key) => ({ "native.html.nothingToOpen": "Não há nada para abrir", "native.html.tooLarge": "Esta página é grande demais para abrir (2 MB)" })[key];
  const options = { t, dir: home, open: () => assert.fail("nothing should open") };
  await assert.rejects(openHtmlCopy(null, "page", options), { message: "Não há nada para abrir" });
  await assert.rejects(openHtmlCopy("x".repeat(2 * 1024 * 1024 + 1), "page", options), { message: "Esta página é grande demais para abrir (2 MB)" });
});

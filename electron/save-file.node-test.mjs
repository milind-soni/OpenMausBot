import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { collisionFreeDownloadPath, defaultSaveName, resolveSavablePath, withSavableFile } from "./save-file.mjs";

// Creating a symlink on Windows needs elevation or developer mode, so the
// symlink cases only run where the runner can actually make one.
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
    // must be fs.promises.realpath, the same call the module makes: on Windows
    // the callback API leaves 8.3 short names ("RUNNER~1") that the promises
    // API expands ("runneradmin"), so mixing the two compares different strings
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
    assert.ok(handler < main.indexOf("createWindow();"));
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
    // These IDs are distinct BigInts but collapse to the same Number. The
    // options assertions below make the precision guarantee executable.
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

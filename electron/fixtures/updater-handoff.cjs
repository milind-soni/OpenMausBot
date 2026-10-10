"use strict";

// Proves the two steps of the Ubuntu hand-off that only exist at runtime: the
// command really reaches the system clipboard, and a terminal is really
// spawned. The unit tests inject a fake runner and never spawn anything, so
// this runs the production path with nothing stubbed — a recording script
// placed on PATH stands in for the terminal emulator, and is discovered and
// executed by the real child_process.

const { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { app, clipboard } = require("electron");

if (process.platform === "linux") app.commandLine.appendSwitch("no-sandbox");

function say(marker) {
  process.stdout.write(`${marker}\n`);
}

async function main() {
  const { handOffDownloadedPackage } = await import("../updater.mjs");
  const { packageInstallCommand } = await import("../package-install-command.mjs");
  const handOff = handOffDownloadedPackage("deb");

  const workspace = mkdtempSync(join(tmpdir(), "omb-handoff-fixture-"));
  const realPath = process.env.PATH;
  try {
    // A real staged file: the hand-off now refuses a path that is gone, so
    // the quoting case has to exist on disk rather than being a string.
    const pending = mkdtempSync(join(workspace, "o'brien "));
    const staged = join(pending, "pkg.deb");
    writeFileSync(staged, "x");
    const expected = packageInstallCommand("deb", staged);

    // A terminal emulator that records being launched. openBlankTerminal tries
    // x-terminal-emulator first on Linux, and resolves it through PATH.
    const receipt = join(workspace, "launched");
    const terminal = join(workspace, "x-terminal-emulator");
    writeFileSync(terminal, `#!/bin/sh\necho "$@" > ${JSON.stringify(receipt)}\n`);
    chmodSync(terminal, 0o755);

    clipboard.writeText("something else entirely");
    process.env.PATH = workspace;
    const result = await handOff([staged]);

    if (clipboard.readText() === expected) say("clipboard-holds-the-install-command");
    else say(`clipboard-mismatch:${JSON.stringify(clipboard.readText())}`);

    if (existsSync(receipt)) say("terminal-really-launched");
    if (result.terminalOpened === true) say("hand-off-reported-the-terminal");
    if (result.command === expected) say("hand-off-returned-the-command");

    // Nothing on PATH: the terminal cannot open, but the command must still be
    // on the clipboard — the docs tell the user to paste it themselves.
    const empty = mkdtempSync(join(tmpdir(), "omb-handoff-empty-"));
    clipboard.writeText("something else entirely");
    process.env.PATH = empty;
    const withoutTerminal = await handOff([staged]);
    if (withoutTerminal.terminalOpened === false) say("no-terminal-is-reported-honestly");
    if (clipboard.readText() === expected) say("clipboard-written-even-without-a-terminal");
    rmSync(empty, { recursive: true, force: true });

    // A download that vanished must be reported, not turned into a command
    // that installs nothing — empty list and a path that used to exist.
    process.env.PATH = realPath;
    await handOff([]).then(
      () => say("missing-download-was-not-reported"),
      (error) => {
        if (/no longer available/.test(error.message)) say("missing-download-is-reported");
      },
    );
    await handOff([join(workspace, "gone.deb")]).then(
      () => say("vanished-download-was-not-reported"),
      (error) => {
        if (/no longer available/.test(error.message)) say("vanished-download-is-reported");
      },
    );
  } finally {
    process.env.PATH = realPath;
    rmSync(workspace, { recursive: true, force: true });
  }

  say("fixture-complete");
  app.exit(0);
}

app.whenReady().then(main).catch((error) => {
  process.stdout.write(`fixture-failed:${error.stack ?? error}\n`);
  app.exit(1);
});

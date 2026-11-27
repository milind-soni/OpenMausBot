import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { enginesBinDir } from "../engine-install.ts";
import { registerPathDir, unregisterPathDir } from "../env-path.ts";
import { codexAppCopyUpdateCommand, codexReleaseUpdate, codexUpdateCommand } from "./codex-update.ts";

const releases = vi.hoisted(() => ({ latest: "0.169.0" as string | null, pinned: "0.167.0" as string | undefined }));
vi.mock("./codex-release.ts", async (original) => ({
  ...await original<typeof import("./codex-release.ts")>(),
  readLatestCodexRelease: async () => releases.latest,
}));
vi.mock("../engine-versions.ts", () => ({ pinnedNpmVersion: () => releases.pinned }));
afterEach(() => { releases.latest = "0.169.0"; releases.pinned = "0.167.0"; });

it("does not offer the app installer for a release newer than the version it installs", async () => {
  const update = await codexReleaseUpdate("codex-cli 0.167.0", "codex", false);
  expect(update).toMatchObject({ title: "Update Codex to 0.169.0", command: "codex update", serverInstall: false });
  expect(update?.message).toContain("0.167.0");
  expect(update?.message).toContain("terminal");
});

it("keeps the app updater when the advertised release is the pinned version", async () => {
  releases.latest = "0.167.0";
  const update = await codexReleaseUpdate("codex-cli 0.166.0", "codex", false);
  expect(update).toMatchObject({ title: "Update Codex to 0.167.0", command: "codex update" });
  expect(update?.serverInstall).not.toBe(false);
});

it("keeps the configured executable's update command when a terminal update is needed", async () => {
  const cli = "'/Applications/My Codex/codex'";
  const update = await codexReleaseUpdate("codex-cli 0.167.0", cli, false);
  // PowerShell runs a quoted path only behind its call operator, so the command differs by the host's platform.
  expect(codexUpdateCommand(cli, "darwin")).toBe("'/Applications/My Codex/codex' update");
  expect(codexUpdateCommand(cli, "win32")).toBe("& '/Applications/My Codex/codex' update");
  expect(update?.command).toBe(codexUpdateCommand(cli, process.platform));
});

it("does not show an update on My Cloud or for an already current copy", async () => {
  expect(await codexReleaseUpdate("codex-cli 0.167.0", "codex", true)).toBeUndefined();
  expect(await codexReleaseUpdate("codex-cli 0.169.0", "codex", false)).toBeUndefined();
});

it("leaves an unpinned installer eligible and ignores an unavailable release lookup", async () => {
  releases.pinned = undefined;
  expect((await codexReleaseUpdate("codex-cli 0.167.0", "codex", false))?.serverInstall).not.toBe(false);
  releases.latest = null;
  expect(await codexReleaseUpdate("codex-cli 0.167.0", "codex", false)).toBeUndefined();
});

it("updates the app's own npm copy in the app's folder, not npm's global copy that `codex update` installs into", async () => {
  expect((await codexReleaseUpdate("codex-cli 0.167.0", "codex", false))?.command).toBe("codex update");
  const bin = enginesBinDir();
  const shim = join(bin, process.platform === "win32" ? "codex.cmd" : "codex");
  mkdirSync(bin, { recursive: true });
  writeFileSync(shim, "", { mode: 0o755 });
  registerPathDir(bin);
  try {
    const update = await codexReleaseUpdate("codex-cli 0.167.0", "codex", false);
    expect(update).toMatchObject({ title: "Update Codex to 0.169.0", serverInstall: false, command: codexAppCopyUpdateCommand("0.169.0") });
    expect(update?.command).toContain("@openai/codex@0.169.0");
  } finally {
    unregisterPathDir(bin);
    rmSync(shim, { force: true });
  }
});

it("quotes the app's folder and package for the shell that runs the copied command", () => {
  expect(codexAppCopyUpdateCommand("0.172.0", "C:\\Users\\O'Neil\\AppData\\Roaming\\OpenMausBot\\tools\\npm", "win32")).toBe(
    "npm install -g --prefix 'C:\\Users\\O''Neil\\AppData\\Roaming\\OpenMausBot\\tools\\npm' --loglevel=error --include=optional '--allow-scripts=@openai/codex' '@openai/codex@0.172.0'",
  );
  expect(codexAppCopyUpdateCommand("0.172.0", "/home/o'neil/My Data/tools/npm", "linux")).toBe(
    "npm install -g --prefix '/home/o'\\''neil/My Data/tools/npm' --loglevel=error --include=optional '--allow-scripts=@openai/codex' '@openai/codex@0.172.0'",
  );
});

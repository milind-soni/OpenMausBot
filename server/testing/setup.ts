// Every test file gets a throwaway home, so DATA_DIR (~/.openmausbot) never touches the real one;
// os.homedir() reads HOME / USERPROFILE at call time, and this runs before server/config.ts is imported.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach } from "vitest";

import { removeTempDir } from "./cleanup.ts";

// Hosted Linux runners may expose working bwrap. Cloud fixtures exercise fake engines without a box;
// mask its probe through PATH so their child servers get the same test environment on every runner image.
if (process.platform === "linux" && process.env.GITHUB_ACTIONS === "true" &&
    process.env.RUNNER_ENVIRONMENT !== "self-hosted" && !process.env.OMB_TEST_BWRAP_SHIM) {
  const shimDir = mkdtempSync(join(tmpdir(), "omb-test-no-bwrap-"));
  writeFileSync(join(shimDir, "bwrap"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  process.env.PATH = `${shimDir}${process.env.PATH ? delimiter + process.env.PATH : ""}`;
  process.env.OMB_TEST_BWRAP_SHIM = shimDir;
  process.once("exit", () => rmSync(shimDir, { recursive: true, force: true }));
}

const home = mkdtempSync(join(tmpdir(), "omb-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
// OMB_DATA_DIR must never escape the throwaway home the suite deletes.
delete process.env.OMB_DATA_DIR;
// Do not let a developer's Hermes global config path leak into per-test homes.
delete process.env.HERMES_HOME;
// A ChatGPT-plan turn links the person's Codex home ($CODEX_HOME or ~/.codex) into its own: keep it in the throwaway home.
delete process.env.CODEX_HOME;
// Named explicitly although homedir() already covers it: the device tests delete this directory wholesale.
process.env.OMB_COMPANION_DIR = join(home, ".openmausbot-companion");

// Product code follows navigator.language; pin it so English assertions do not depend on the host locale.
Object.defineProperty(globalThis.navigator, "language", { value: "en", configurable: true });

// Windows will not remove a directory holding an open SQLite database: close it before the reset.
const { closeMessageDb } = await import("../message-db.ts");
afterEach(closeMessageDb);

// Windows holds a live process's cwd, and a just-killed CLI lets go a beat after the kill returns.
afterAll(async () => {
  closeMessageDb();
  await removeTempDir(home);
});

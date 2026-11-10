// Every test file gets a throwaway home, so DATA_DIR (~/.openmausbot) never touches the real one;
// os.homedir() reads HOME / USERPROFILE at call time, and this runs before server/config.ts is imported.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";

import { removeTempDir } from "./cleanup.ts";

const home = mkdtempSync(join(tmpdir(), "omb-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
// OMB_DATA_DIR must never escape the throwaway home the suite deletes.
delete process.env.OMB_DATA_DIR;
// Do not let a developer's Hermes global config path leak into per-test homes.
delete process.env.HERMES_HOME;
// A ChatGPT-plan turn links the person's Codex home ($CODEX_HOME or ~/.codex) into its own: keep it in the throwaway home.
delete process.env.CODEX_HOME;
// No server in a test downloads the project's announcement cards; its tests hand the store a fake fetch.
process.env.OMB_DISABLE_ANNOUNCEMENTS = "1";
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

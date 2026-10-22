// Every source file over 1,000 lines is listed here with its line count, and
// a count may only go down: a PR that grows one of these files, or adds a new
// file over 1,000 lines, fails here. Lower a number when you shrink the file;
// remove the line when it drops under 1,000. The split program
// (server/host/README.md) moves server/index.ts into modules of under 1,500
// lines; nothing new may exceed HARD_CAP, and the files listed above the cap
// are the ones that program takes apart. Tests, fixtures, goldens and
// vendored code are not counted.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url);
const HARD_CAP = 2000;
const LISTED_FROM = 1000;

const LINES: Record<string, number> = {
  "server/index.ts": 16958,
  "src/state/store.tsx": 3525,
  "electron/main.mjs": 3319,
  "server/store.ts": 2450,
  "src/components/Sidebar.tsx": 2318,
  "server/drivers/claude.ts": 2160,
  "server/drivers/acp/core.ts": 1912,
  "server/drivers/codex.ts": 1872,
  "server/routines.ts": 1613,
  "src/components/ComputerPanel.tsx": 1835,
  "src/components/RoutineCalendarPage.tsx": 1750,
  "server/config.ts": 1435,
  "src/components/ChatView.tsx": 1437,
  "server/routine-requests.ts": 1484,
  "src/components/GroupView.tsx": 1590,
  "src/components/LocalComputerSection.tsx": 1475,
  "src/components/CursorAvatar.tsx": 1329,
  "server/skills.ts": 1391,
  "server/composio.ts": 1345,
  "server/vps-computer.ts": 1369,
  "scripts/mcp-server.ts": 1487,
  "server/boat.ts": 1258,
  "server/drivers/pi.ts": 1150,
  "server/container-computer.ts": 1249,
  "src/components/Composer.tsx": 1072,
  "src/components/ModelPicker.tsx": 1204,
  "src/components/PhoneSetupFlow.tsx": 1283,
  "server/cli.ts": 1080,
  "src/components/ChatMarkdown.tsx": 1039,
  "src/components/PluginsPanel.tsx": 1113,
  "server/org-library.ts": 1003,
  "src/components/AttachmentPreview.tsx": 1044,
};

function sourceFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "server", "shared", "src", "scripts", "evals", "electron", "companion"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter((file) => /\.(ts|tsx|mjs|cjs)$/.test(file))
    .filter((file) => !file.includes(".test.") && !file.includes("/testing/") && !file.includes("goldens") && !file.startsWith("electron/vendor/"));
}

const count = (file: string) => readFileSync(new URL(file, ROOT), "utf8").split("\n").length - 1;

describe("source files stay a readable size", () => {
  it("no listed file grows, and no file over 1,000 lines goes unlisted", () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const file of sourceFiles()) {
      const lines = count(file);
      const pinned = LINES[file];
      if (pinned !== undefined) {
        seen.add(file);
        if (lines > pinned) problems.push(`${file} grew to ${lines} lines (listed at ${pinned}): move code out, do not add here`);
        if (lines < LISTED_FROM) problems.push(`${file} is ${lines} lines: remove its line from LINES`);
        else if (lines < pinned) problems.push(`${file} is ${lines} lines: lower its number to ${lines}`);
      } else if (lines > LISTED_FROM) {
        problems.push(lines > HARD_CAP
          ? `${file} is ${lines} lines, over the ${HARD_CAP}-line cap: split it`
          : `${file} is ${lines} lines: a new file over ${LISTED_FROM} lines needs a line here and a reason in the PR`);
      }
    }
    for (const file of Object.keys(LINES)) if (!seen.has(file)) problems.push(`${file} is gone: remove its line from LINES`);
    expect(problems, "See server/host/README.md").toEqual([]);
  });
});

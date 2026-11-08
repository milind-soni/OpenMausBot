// Every source file over 1,000 lines is listed here with its line count, and
// a count may only go down: a PR that grows one of these files, or adds a new
// file over 1,000 lines, fails here. A PR that shrinks a file leaves its number
// alone: scripts/tighten-ratchets.mjs lowers the numbers (and drops files under
// 1,000 lines) at each release, so two such PRs never conflict here. The split program
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
  "server/index.ts": 15636,
  "src/state/store.tsx": 3349,
  "electron/main.mjs": 3224,
  "server/store.ts": 2307,
  "src/components/Sidebar.tsx": 1689,
  "server/drivers/claude.ts": 2095,
  "server/drivers/acp/core.ts": 1758,
  "server/drivers/codex.ts": 1730,
  "server/routines.ts": 1567,
  "src/components/ComputerPanel.tsx": 1817,
  "src/components/RoutineCalendarPage.tsx": 1622,
  "server/config.ts": 1265,
  "src/components/ChatView.tsx": 1306,
  "server/routine-requests.ts": 1474,
  "src/components/GroupView.tsx": 1220,
  "src/components/LocalComputerSection.tsx": 1452,
  "src/components/CursorAvatar.tsx": 1324,
  "server/skills.ts": 1380,
  "server/composio.ts": 1091,
  "server/vps-computer.ts": 1369,
  "scripts/mcp-server.ts": 1412,
  "server/boat.ts": 1258,
  "server/drivers/pi.ts": 1033,
  "server/plan-usage.ts": 1046,
  "server/container-computer.ts": 1225,
  "src/components/ModelPicker.tsx": 1039,
  "src/components/PhoneSetupFlow.tsx": 1101,
  "server/cli.ts": 1062,
  "src/components/AttachmentPreview.tsx": 1035,
  "server/meetings/meetbot.ts": 1047,
  "server/message-db.ts": 1005,
  "server/drivers/openai-chat.ts": 1001,
};

function sourceFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "server", "shared", "src", "scripts", "evals", "electron", "companion"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter((file) => /\.(ts|tsx|mjs|cjs)$/.test(file))
    .filter((file) => !file.includes(".test.") && !file.includes("/testing/") && !file.includes("goldens") && !file.startsWith("electron/vendor/"));
}

const count = (file: string) => readFileSync(new URL(file, ROOT), "utf8").split("\n").length - 1;

describe("source files stay a readable size", () => {
  it("no listed file grows, and no new file over 1,000 lines goes unlisted", () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const file of sourceFiles()) {
      const lines = count(file);
      const pinned = LINES[file];
      if (pinned !== undefined) {
        seen.add(file);
        if (lines > pinned) problems.push(`${file} grew to ${lines} lines (listed at ${pinned}): move code out, do not add here`);
      } else if (lines > LISTED_FROM) {
        problems.push(lines > HARD_CAP
          ? `${file} is ${lines} lines, over the ${HARD_CAP}-line cap: split it`
          : `${file} is ${lines} lines: a new file over ${LISTED_FROM} lines needs a line here and a reason in the PR`);
      }
    }
    expect(problems, "See server/host/README.md").toEqual([]);
  });
});

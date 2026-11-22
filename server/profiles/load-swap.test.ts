import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { problemSentence } from "../../shared/profile-format.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const swap = vi.hoisted(() => ({ at: "", before: (() => {}) as () => void, after: (() => {}) as () => void }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const openSync = ((path: string, ...rest: never[]) => {
    if (swap.at && String(path).endsWith(swap.at)) {
      swap.at = "";
      swap.before();
      try {
        return (fs.openSync as (...args: unknown[]) => number)(path, ...rest);
      } finally {
        swap.after();
      }
    }
    return (fs.openSync as (...args: unknown[]) => number)(path, ...rest);
  }) as typeof fs.openSync;
  return { ...fs, openSync, default: { ...fs, openSync } };
});

const { loadProfileFolder } = await import("./load.ts");

const ACME = join(import.meta.dirname, "..", "testing", "fixtures", "profiles", "acme");
const scratch = mkdtempSync(join(tmpdir(), "omb-profiles-swap-"));
afterAll(() => removeTempDir(scratch));

let n = 0;
function swappable(): { dir: string; toLink: () => void; back: () => void } {
  const dir = join(scratch, `acme-${++n}`);
  cpSync(ACME, dir, { recursive: true });
  const outside = join(scratch, `outside-${n}`);
  mkdirSync(outside);
  writeFileSync(join(outside, "analyst.md"), "---\nedubot: 1\nkind: bot\nkey: analyst\nname: Spy\n---\nOUTSIDE_CANARY\n");
  const bots = join(dir, "areas", "bi", "bots");
  return {
    dir,
    toLink: () => {
      renameSync(bots, `${bots}-real`);
      symlinkSync(outside, bots);
    },
    back: () => {
      rmSync(bots);
      renameSync(`${bots}-real`, bots);
    },
  };
}

describe.skipIf(process.platform === "win32")("a bots folder swapped for a link between the listing and the open", () => {
  it.each([
    ["left as a link", false],
    ["swapped back right after the open", true],
  ])("is refused, and nothing from outside is read: %s", (_name, swapBack) => {
    const folder = swappable();
    swap.at = join("areas", "bi", "bots", "analyst.md");
    swap.before = folder.toLink;
    swap.after = swapBack ? folder.back : () => {};
    const loaded = loadProfileFolder(folder.dir);
    expect(loaded.problems.map(problemSentence)).toContain("areas/bi/bots/analyst.md: is a link; profiles never follow links, so put the file itself in the folder");
    expect(JSON.stringify(loaded)).not.toContain("OUTSIDE_CANARY");
  });
});

// Windows refuses to rename a folder while a file in it is open.
describe.skipIf(process.platform === "win32")("a bots folder that disappears between the open and the identity check", () => {
  it("is refused with a plain problem, and the load does not throw", () => {
    const folder = swappable();
    const bots = join(folder.dir, "areas", "bi", "bots");
    swap.at = join("areas", "bi", "bots", "analyst.md");
    swap.before = () => {};
    swap.after = () => renameSync(bots, `${bots}-gone`);
    const loaded = loadProfileFolder(folder.dir);
    expect(loaded.problems.map(problemSentence)).toContain("areas/bi/bots/analyst.md: is a link; profiles never follow links, so put the file itself in the folder");
    expect(loaded.bots.map((bot) => bot.key)).not.toContain("analyst");
  });
});

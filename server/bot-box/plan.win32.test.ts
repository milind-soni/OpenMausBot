import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { describeBoxArgs, physicalPath, planBox, visibleInBox } from "./plan.ts";

vi.mock("node:path", async (original) => {
  const path = await original<typeof import("node:path")>();
  const resolve = (...paths: string[]) => path.win32.resolve("D:\\fixture", ...paths);
  return { ...path, ...path.win32, resolve, relative: (from: string, to: string) => path.win32.relative(resolve(from), resolve(to)) };
});
vi.mock("node:fs", async (original) => ({
  ...await original<typeof import("node:fs")>(),
  realpathSync: () => { throw Object.assign(new Error("Missing fixture path"), { code: "ENOENT" }); },
}));

beforeEach(() => { vi.stubGlobal("process", { ...process, platform: "win32" }); });
afterEach(() => { vi.unstubAllGlobals(); });

const setup = {
  dataDir: "/data/.openmausbot", home: "/data", codeRoots: ["/app", "/usr/local/bin", "/etc/tools", "/opt/chrome", "/var/lib/tools"],
  engineRoots: [], bridges: [],
};
const request = { command: "/usr/bin/x", args: [], env: { TMPDIR: "/tmp" }, cwd: "/data/.openmausbot/task-workspaces/b1/t1" };

it("keeps the box image's system mount sources literal on Windows", () => {
  const plan = planBox(setup, request);
  expect(describeBoxArgs(plan).slice(0, 3)).toEqual(["--ro-bind", "/usr", "/usr"]);
  expect(plan.mounts.filter((mount) => mount.kind === "ro")).toEqual([
    { kind: "ro", source: "/usr", target: "/usr" },
    { kind: "ro", source: "/etc", target: "/etc" },
    { kind: "ro", source: "/opt", target: "/opt", optional: true },
    { kind: "ro", source: "/var/lib", target: "/var/lib", optional: true },
    { kind: "ro", source: "D:\\app", target: "D:\\app" },
    { kind: "ro", source: "D:\\data\\.openmausbot\\bots\\b1\\SOUL.md", target: "D:\\data\\.openmausbot\\bots\\b1\\SOUL.md", optional: true },
  ]);
});

it("still resolves host paths and keeps private image directories masked on Windows", () => {
  const plan = planBox(setup, request);
  expect(physicalPath(setup.dataDir)).toBe("D:\\data\\.openmausbot");
  expect(physicalPath("relative")).toBe("D:\\fixture\\relative");
  expect(plan.botId).toBe("b1");
  expect(visibleInBox(plan, request.cwd)).toBe("rw");
  expect(visibleInBox(plan, "/data/.openmausbot/messages.db")).toBe("none");
  expect(visibleInBox(plan, "/tmp/another-turn")).toBe("none");
  expect(plan.writable).not.toContain("D:\\tmp");
});

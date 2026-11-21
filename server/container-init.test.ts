import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canRun, containerInit, execUnderInit, IMAGE_INIT, UNDER_IMAGE_INIT } from "./container-init.ts";

const asOne = { pid: 1, platform: "linux" as const, execPath: "/usr/local/bin/node", execArgv: ["--max-old-space-size=3072"], argv: ["/usr/local/bin/node", "/app/dist-server/server-launcher.js", "--flag"] };

describe("the server as a container's process 1", () => {
  it("changes nothing behind an init, and nothing outside Linux", () => {
    expect(containerInit({ pid: 7, platform: "linux", runnable: () => true, env: {} })).toEqual({ exec: null, line: null });
    for (const platform of ["darwin", "win32"] as const) expect(containerInit({ ...asOne, platform, runnable: () => true, env: {} })).toEqual({ exec: null, line: null });
  });

  it("starts the launcher again under the image's tini, with its own flags, arguments and environment, and says so in one line", () => {
    const init = containerInit({ ...asOne, runnable: (path) => path === IMAGE_INIT, env: { NODE_OPTIONS: "--enable-source-maps", OMB_DATA_DIR: "/data" } });
    expect(init.exec).toEqual({
      file: "/usr/bin/tini",
      args: ["/usr/bin/tini", "--", "/usr/local/bin/node", "--max-old-space-size=3072", "/app/dist-server/server-launcher.js", "--flag"],
      env: { NODE_OPTIONS: "--enable-source-maps", OMB_DATA_DIR: "/data", [UNDER_IMAGE_INIT]: "1" },
    });
    expect(init.line).toContain("process 1");
    expect(init.line).toContain("docs/self-hosting.md");
    expect(init.line).not.toContain("\n");
  });

  it("never starts itself again once it already has", () => {
    const init = containerInit({ ...asOne, runnable: () => true, env: { [UNDER_IMAGE_INIT]: "1" } });
    expect(init.exec).toBeNull();
    expect(init.line).toContain("spawn EAGAIN");
    expect(init.line).not.toContain("\n");
  });

  it("without tini only says what will happen and how to fix it", () => {
    const init = containerInit({ ...asOne, runnable: () => false, env: {} });
    expect(init.exec).toBeNull();
    expect(init.line).toContain("spawn EAGAIN");
    expect(init.line).toContain("--init");
    expect(init.line).not.toContain("\n");
  });

  it("does not hand execve a tini it cannot run: Node 24 aborts the process when execve fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-init-"));
    try {
      const plain = join(dir, "tini"), program = join(dir, "program");
      writeFileSync(plain, "", { mode: 0o644 });
      writeFileSync(program, "#!/bin/sh\n", { mode: 0o755 });
      // Windows has no execute bit (X_OK checks only that the file exists), so a 0644 file counts there; the server
      // only ever execs tini on Linux, where the bit is what Node 24's execve would trip on.
      const refused = process.platform === "win32" ? [dir, "/dev/null", join(dir, "missing")] : [plain, dir, "/dev/null", join(dir, "missing")];
      for (const file of refused) expect(canRun(file), file).toBe(false);
      expect(canRun(program)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("carries on without an init, in one line, when the exec is refused or this Node has none", () => {
    const exec = { file: IMAGE_INIT, args: [IMAGE_INIT, "--", "node"], env: {} };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const refused = vi.fn(() => { throw Object.assign(new Error("EACCES: permission denied, execve '/usr/bin/tini'"), { code: "EACCES" }); });
      execUnderInit(exec, refused as never);
      expect(refused).toHaveBeenCalledWith(IMAGE_INIT, exec.args, exec.env);
      execUnderInit(exec, null);
      expect(warn).toHaveBeenCalledTimes(2);
      for (const [line] of warn.mock.calls) {
        expect(line).toContain("spawn EAGAIN");
        expect(line).not.toContain("\n");
      }
      expect(warn.mock.calls[0]![0]).toContain("EACCES");
    } finally { warn.mockRestore(); }
  });
});

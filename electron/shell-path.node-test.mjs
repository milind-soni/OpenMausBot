import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sharedCommand } from "./shared-computer-access.mjs";
import { commandPath, probeShellPath } from "./shell-path.mjs";

const payload = result => JSON.parse(result.content[0].text);

test("a lent command finds the tools on the person's shell PATH though the app was opened from the Dock", { skip: process.platform === "win32" }, async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-shell-path-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "brew", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "fixture-gh"), "#!/bin/sh\necho fixture-gh-ran\n");
  await chmod(path.join(bin, "fixture-gh"), 0o755);
  const shell = path.join(dir, "login-shell");
  await writeFile(shell, `#!/bin/sh\necho "Last login: rc noise"\nprintf '__OMB_PATH__%s' '${bin}:/usr/bin:/bin'\n`);
  await chmod(shell, 0o755);
  const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL };
  t.after(() => Object.assign(process.env, saved));
  Object.assign(process.env, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: shell });
  const result = payload(await sharedCommand("fixture-gh", dir, new AbortController().signal));
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /fixture-gh-ran/);
});

test("the shell PATH comes first, then the app's own and the usual install folders, each once", async () => {
  const merged = await commandPath({ platform: "darwin", env: { PATH: "/usr/bin:/bin" }, home: "/nowhere", probe: async () => "/opt/fixture/bin:/usr/bin", exists: dir => dir === "/opt/homebrew/bin" });
  assert.equal(merged, "/opt/fixture/bin:/usr/bin:/bin:/opt/homebrew/bin");
  const unread = await commandPath({ platform: "darwin", env: { PATH: "/usr/bin:/bin" }, home: "/nowhere", probe: async () => null, exists: () => true });
  assert.equal(unread, "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/nowhere/.local/bin");
  assert.equal(await commandPath({ platform: "win32", env: { PATH: "C:\\Windows" }, probe: async () => assert.fail("never probed on Windows") }), "C:\\Windows");
});

test("a login shell that fails, prints nothing or hangs gives no PATH", { skip: process.platform === "win32" }, async () => {
  assert.equal(await probeShellPath({ shell: "/nonexistent/shell" }), null);
  assert.equal(await probeShellPath({ shell: "/usr/bin/true" }), null);
});

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { UPDATE_FILES } from "../src/adopted-home.ts";
import { CUSTOMER_HOME_IMAGE } from "../src/customer-run.ts";

const SCRIPT = join(import.meta.dirname, "..", "host", "mausbot-update-runner.sh");
const IMAGE = `ghcr.io/milind-soni/openmausbot@sha256:${"b".repeat(64)}`;
const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs the runner on a request, beside an update.sh that records how it was called and exits with `exit`. */
function run(request: string | null, options: { exit?: number; updater?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-update-runner-"));
  dirs.push(dir);
  const update = join(dir, "update");
  const install = join(dir, "opt-openmausbot");
  mkdirSync(update);
  mkdirSync(install);
  const called = join(dir, "called");
  if (options.updater !== false) {
    writeFileSync(join(install, "update.sh"), `printf '%s\\n' "$*" >> "${called}"\nexit ${options.exit ?? 0}\n`);
    chmodSync(join(install, "update.sh"), 0o755);
  }
  if (request !== null) writeFileSync(join(update, UPDATE_FILES.request), request);
  const result = spawnSync("sh", [SCRIPT], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", MAUSBOT_UPDATE_DIR: update, MAUSBOT_INSTALL_DIR: install }, timeout: 30_000 });
  const answer = existsSync(join(update, UPDATE_FILES.result)) ? readFileSync(join(update, UPDATE_FILES.result), "utf8") : null;
  return { result, answer, calls: existsSync(called) ? readFileSync(called, "utf8").trim().split("\n") : [], install, pending: existsSync(join(update, UPDATE_FILES.request)) };
}

describe.skipIf(!posix)("mausbot-update-runner.sh", () => {
  it("is plain POSIX sh and accepts the image the connector accepts", () => {
    expect(spawnSync("sh", ["-n", SCRIPT]).status).toBe(0);
    expect(readFileSync(SCRIPT, "utf8")).toContain("'ghcr\\.io/milind-soni/openmausbot@sha256:[0-9a-f]{64}'");
    expect(CUSTOMER_HOME_IMAGE.source).toBe("^ghcr\\.io\\/milind-soni\\/openmausbot@sha256:[0-9a-f]{64}$");
  });

  it("hands a request to the install's own update.sh with the image, and writes down how it ended", () => {
    const done = run(`id=u1\nimage=${IMAGE}\n`);
    expect(done.result.status).toBe(0);
    expect(done.calls).toEqual([`--dir ${done.install} --image ${IMAGE}`]);
    expect(done.answer).toBe("id=u1\ncode=0\n");
    expect(done.pending).toBe(false);
    expect(run(`id=u2\nimage=${IMAGE}\n`, { exit: 1 }).answer).toBe("id=u2\ncode=1\n");
    expect(run(`id=u3\nimage=${IMAGE}\n`, { exit: 2 }).answer).toBe("id=u3\ncode=2\n");
  });

  it("runs nothing for an image that is not MausBot's server image by digest, whatever the request says", () => {
    for (const image of ["ghcr.io/milind-soni/openmausbot:latest", "ghcr.io/someone/openmausbot@sha256:" + "b".repeat(64), `${IMAGE} --replace-local-build`, `${IMAGE};reboot`, ""]) {
      const refused = run(`id=u1\nimage=${image}\n`);
      expect(refused.calls, image).toEqual([]);
      expect(refused.answer, image).toBe("id=u1\ncode=4\n");
    }
    const odd = run(`id=u1;reboot\nimage=${IMAGE}\n`);
    expect(odd.calls).toEqual([]);
    expect(odd.answer).toBeNull();
    expect(odd.pending).toBe(false);
  });

  it("answers 127 when the install has no update.sh, and does nothing without a request", () => {
    expect(run(`id=u1\nimage=${IMAGE}\n`, { updater: false }).answer).toBe("id=u1\ncode=127\n");
    const idle = run(null);
    expect(idle.result.status).toBe(0);
    expect(idle.answer).toBeNull();
    expect(idle.calls).toEqual([]);
  });
});

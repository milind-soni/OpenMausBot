// The one write the connector makes on a customer-run server, run for real: customer-run.ts `licenceCommand` through sh,
// with OMB_DATA_DIR in a temporary folder, as it runs inside the server's container. POSIX shells only.
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LICENCE_EXIT, licenceCommand } from "../src/customer-run.ts";

const LICENCE = `omb1.${Buffer.from(JSON.stringify({ v: 1, customer: "Acme", features: [] })).toString("base64url")}.${"s".repeat(86)}`;
const OTHER = `omb1.${Buffer.from(JSON.stringify({ v: 1, customer: "Acme", features: ["budgets"] })).toString("base64url")}.${"t".repeat(86)}`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { chmodSync(join(dir, "data"), 0o700); } catch { /* gone or never made */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A server's install folder with its data folder inside, and a file beside the data folder that must never change. */
function install() {
  const root = mkdtempSync(join(tmpdir(), "omb-licence-write-"));
  dirs.push(root);
  const data = join(root, "data");
  mkdirSync(data, { mode: 0o700 });
  writeFileSync(join(root, "license.key"), "outside\n");
  writeFileSync(join(root, "elsewhere.txt"), "a file a link points at\n");
  return { root, data, file: join(data, "license.key") };
}

function run(data: string, mode: "check" | "write", licence = LICENCE): number {
  const [shell, ...args] = licenceCommand(mode, licence);
  const result = spawnSync(shell!, args, { env: { PATH: process.env.PATH, OMB_DATA_DIR: data }, encoding: "utf8" });
  return result.status ?? -1;
}

/** Back-dated past the paste window, as a licence written an hour ago would be. */
const old = (path: string) => utimesSync(path, new Date(Date.now() - 60 * 60_000), new Date(Date.now() - 60 * 60_000));

describe.skipIf(process.platform === "win32")("the licence write, run through sh", () => {
  it("writes license.key in the data folder, readable by its owner only, and leaves nothing else", () => {
    const { root, data, file } = install();
    expect(run(data, "check")).toBe(LICENCE_EXIT.differs);
    expect(readdirSync(data)).toEqual([]);
    expect(run(data, "write")).toBe(LICENCE_EXIT.written);
    expect(readFileSync(file, "utf8")).toBe(`${LICENCE}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(data)).toEqual(["license.key"]);
    // Not beside the data folder, and nothing there changed.
    expect(readFileSync(join(root, "license.key"), "utf8")).toBe("outside\n");
    expect(readdirSync(root).sort()).toEqual(["data", "elsewhere.txt", "license.key"]);
  });

  it("answers 3 for the same licence, with or without writing, and changes nothing", () => {
    const { data, file } = install();
    expect(run(data, "write")).toBe(LICENCE_EXIT.written);
    old(file);
    const before = statSync(file);
    expect(run(data, "check")).toBe(LICENCE_EXIT.same);
    expect(run(data, "write")).toBe(LICENCE_EXIT.same);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(file).ino).toBe(before.ino);
  });

  it("replaces an older licence in one rename, once the file is past the paste window", () => {
    const { data, file } = install();
    writeFileSync(file, `${OTHER}\n`, { mode: 0o600 });
    expect(run(data, "write")).toBe(LICENCE_EXIT.recent);
    expect(readFileSync(file, "utf8")).toBe(`${OTHER}\n`);
    old(file);
    const before = statSync(file).ino;
    expect(run(data, "check")).toBe(LICENCE_EXIT.differs);
    expect(run(data, "write")).toBe(LICENCE_EXIT.written);
    expect(readFileSync(file, "utf8")).toBe(`${LICENCE}\n`);
    expect(statSync(file).ino).not.toBe(before);
    expect(readdirSync(data)).toEqual(["license.key"]);
  });

  it("replaces a link at license.key with a file, and leaves what it pointed at alone", () => {
    const { root, data, file } = install();
    symlinkSync(join(root, "elsewhere.txt"), file);
    old(join(root, "elsewhere.txt"));
    spawnSync("touch", ["-h", "-t", "202001010000", file]);
    expect(run(data, "write")).toBe(LICENCE_EXIT.written);
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(`${LICENCE}\n`);
    expect(readFileSync(join(root, "elsewhere.txt"), "utf8")).toBe("a file a link points at\n");
  });

  it("fails, writing nothing, when the data folder is missing, cannot be written, or license.key is a folder or a link to one", () => {
    const { root, data, file } = install();
    expect(run(join(root, "missing"), "write")).toBe(LICENCE_EXIT.failed);
    expect(readdirSync(root).sort()).toEqual(["data", "elsewhere.txt", "license.key"]);

    mkdirSync(file);
    expect(run(data, "check")).toBe(LICENCE_EXIT.failed);
    expect(run(data, "write")).toBe(LICENCE_EXIT.failed);
    expect(readdirSync(file)).toEqual([]);
    rmSync(file, { recursive: true });

    mkdirSync(join(root, "a-folder"));
    symlinkSync(join(root, "a-folder"), file);
    expect(run(data, "write")).toBe(LICENCE_EXIT.failed);
    expect(readdirSync(join(root, "a-folder"))).toEqual([]);
    rmSync(file);

    if (process.getuid?.() !== 0) {
      chmodSync(data, 0o500);
      expect(run(data, "write")).toBe(LICENCE_EXIT.failed);
      chmodSync(data, 0o700);
      expect(readdirSync(data)).toEqual([]);
    }
    expect(readFileSync(join(root, "license.key"), "utf8")).toBe("outside\n");
  });

  it("refuses to build the command for anything that is not a licence", () => {
    for (const bad of [`${LICENCE}"; touch /tmp/x; "`, "omb1.a.b", `${LICENCE}\n`]) expect(() => licenceCommand("write", bad)).toThrow();
  });
});

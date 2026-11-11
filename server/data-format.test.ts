import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkDataFormat, DATA_FORMAT, DATA_FORMAT_FILE, DataFormatError, dataFormatStepProblem, readDataFormat, stampDataFormat, type ReleasedDataFormat,
} from "./data-format.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = join(import.meta.dirname, "..");
const { version: VERSION } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
const released = JSON.parse(readFileSync(join(import.meta.dirname, "data-format-released.json"), "utf8")) as ReleasedDataFormat;
const dirs: string[] = [];
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-data-format-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the N-1 rule", () => {
  it("holds for this tree: the last release can read the data this version writes", () => {
    expect(dataFormatStepProblem(DATA_FORMAT, released)).toBeNull();
  });

  it("is held against the release this tree follows, recorded by the release tooling and not by hand", () => {
    expect(released.version, "server/data-format-released.json is for another release: run `node scripts/record-data-format.mjs` only as part of a version bump").toBe(VERSION);
    expect(readFileSync(join(ROOT, ".github", "workflows", "prepare-release.yml"), "utf8")).toContain("node scripts/record-data-format.mjs");
  });

  it("fails a format bump that skips the two-release step", () => {
    const last = { version: "0.1.151", writes: 1, reads: 1 };
    expect(dataFormatStepProblem({ writes: 1, reads: 1 }, last)).toBeNull();
    expect(dataFormatStepProblem({ writes: 2, reads: 2 }, last)).toContain("release 0.1.151 reads only up to 1");
    expect(dataFormatStepProblem({ writes: 2, reads: 2 }, last)).toContain("Raise reads to 2 now");
    // Release one: read the new format. Release two: write it.
    expect(dataFormatStepProblem({ writes: 1, reads: 2 }, last)).toBeNull();
    expect(dataFormatStepProblem({ writes: 2, reads: 2 }, { version: "0.1.152", writes: 1, reads: 2 })).toBeNull();
    expect(dataFormatStepProblem({ writes: 2, reads: 3 }, { version: "0.1.152", writes: 1, reads: 2 })).toBeNull();
    expect(dataFormatStepProblem({ writes: 1, reads: 3 }, last)).toContain("one format at a time");
    expect(dataFormatStepProblem({ writes: 2, reads: 1 }, last)).toContain("a version reads what it writes");
    expect(dataFormatStepProblem({ writes: 1, reads: 1 }, { version: "0.1.152", writes: 1, reads: 2 })).toContain("went down");
    expect(dataFormatStepProblem({ writes: 1, reads: 2 }, { version: "0.1.153", writes: 2, reads: 2 })).toContain("went down");
  });
});

describe("the data folder's format marker", () => {
  it("is written on first start and left alone after that", () => {
    const dir = dataDir();
    expect(readDataFormat(dir)).toBeNull();
    stampDataFormat(dir, "0.1.152");
    const first = readFileSync(join(dir, DATA_FORMAT_FILE), "utf8");
    expect(JSON.parse(first)).toMatchObject({ format: DATA_FORMAT.writes, writtenBy: "0.1.152" });
    stampDataFormat(dir, "0.1.153");
    expect(readFileSync(join(dir, DATA_FORMAT_FILE), "utf8")).toBe(first);
    expect(readdirSync(dir)).toEqual([DATA_FORMAT_FILE]);
  });

  it("moves up when a version writes a newer format, and an older version that can still read it leaves it there", () => {
    const dir = dataDir();
    stampDataFormat(dir, "0.1.152", { writes: 1, reads: 2 });
    stampDataFormat(dir, "0.1.153", { writes: 2, reads: 2 });
    expect(readDataFormat(dir)).toMatchObject({ format: 2, writtenBy: "0.1.153" });
    // The rollback the rule exists for: 0.1.152 reads format 2, and does not pretend the data is format 1 again.
    expect(() => stampDataFormat(dir, "0.1.152", { writes: 1, reads: 2 })).not.toThrow();
    expect(readDataFormat(dir)).toMatchObject({ format: 2, writtenBy: "0.1.153" });
  });

  it("refuses data a newer version left in a format it cannot read, in plain words, and changes nothing", () => {
    const dir = dataDir();
    const marker = `${JSON.stringify({ format: 3, writtenBy: "0.2.0", writtenAt: "2027-01-01T00:00:00.000Z" })}\n`;
    writeFileSync(join(dir, DATA_FORMAT_FILE), marker);
    const refusal = `OpenMausBot startup failed: the data in ${dir} was written by a newer OpenMausBot (0.2.0), in a format this version (0.1.152) cannot read. Nothing was changed. Install OpenMausBot 0.2.0 or newer, or put back the copy of the data taken before that update.`;
    expect(() => checkDataFormat(dir, "0.1.152", 2)).toThrow(new DataFormatError(refusal));
    expect(() => stampDataFormat(dir, "0.1.152", { writes: 2, reads: 2 })).toThrow(DataFormatError);
    expect(readFileSync(join(dir, DATA_FORMAT_FILE), "utf8")).toBe(marker);
    expect(readdirSync(dir)).toEqual([DATA_FORMAT_FILE]);
    expect(() => checkDataFormat(dir, "0.2.0", 3)).not.toThrow();
  });

  // What a power loss, an editor or a restore by hand can leave behind.
  const GARBLED = ["", "\0".repeat(64), "{", "{}", "null", '{"format":"2"}', '{"format":0}', '{"format":1.5}'];

  it("takes a marker it cannot read as format 1 while no version writes a newer one, and puts a good one back", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const text of GARBLED) {
        const dir = dataDir();
        writeFileSync(join(dir, DATA_FORMAT_FILE), text);
        expect(() => checkDataFormat(dir, "0.1.152", 1, 1), JSON.stringify(text)).not.toThrow();
        stampDataFormat(dir, "0.1.152", { writes: 1, reads: 1 });
        expect(readDataFormat(dir), JSON.stringify(text)).toMatchObject({ format: 1, writtenBy: "0.1.152" });
      }
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("cannot be read; taking the data as format 1"));
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a marker it cannot read once a version writes a newer format, since the data may then be in it", () => {
    for (const text of GARBLED) {
      const dir = dataDir();
      writeFileSync(join(dir, DATA_FORMAT_FILE), text);
      expect(() => checkDataFormat(dir, "0.1.160", 2, 2), JSON.stringify(text)).toThrow(/cannot be read, so this version cannot tell/);
      expect(readFileSync(join(dir, DATA_FORMAT_FILE), "utf8")).toBe(text);
    }
  });

  it("reads a marker behind a byte-order mark, and still refuses a newer format there", () => {
    const dir = dataDir();
    writeFileSync(join(dir, DATA_FORMAT_FILE), `\uFEFF${JSON.stringify({ format: 1, writtenBy: "0.1.151", writtenAt: "" })}`);
    expect(readDataFormat(dir)).toMatchObject({ format: 1, writtenBy: "0.1.151" });
    writeFileSync(join(dir, DATA_FORMAT_FILE), `\uFEFF${JSON.stringify({ format: 3, writtenBy: "0.2.0", writtenAt: "" })}`);
    expect(() => checkDataFormat(dir, "0.1.152", 1, 1)).toThrow("written by a newer OpenMausBot (0.2.0)");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("starts on a marker this user cannot read, and on a folder it cannot write", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = dataDir();
    writeFileSync(join(dir, DATA_FORMAT_FILE), JSON.stringify({ format: 1, writtenBy: "0.1.151", writtenAt: "" }));
    chmodSync(join(dir, DATA_FORMAT_FILE), 0o000);
    chmodSync(dir, 0o555);
    try {
      expect(() => checkDataFormat(dir, "0.1.152", 1, 1)).not.toThrow();
      // The stamp cannot replace it (EACCES): said in the log, and the start goes on.
      expect(() => stampDataFormat(dir, "0.1.152", { writes: 1, reads: 1 })).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not write .*data-format\.json .*starting without it/));
      expect(readdirSync(dir)).toEqual([DATA_FORMAT_FILE]);
    } finally {
      chmodSync(dir, 0o755);
      chmodSync(join(dir, DATA_FORMAT_FILE), 0o644);
      warn.mockRestore();
    }
  });

  it("never ends a start over a marker it cannot write: a Windows file held open, a full disk", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const code of ["EPERM", "EACCES", "ENOSPC", "EROFS"]) {
        const dir = dataDir();
        const failing = () => {
          throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
        };
        expect(() => stampDataFormat(dir, "0.1.152", DATA_FORMAT, failing), code).not.toThrow();
        expect(readDataFormat(dir)).toBeNull();
      }
    } finally {
      warn.mockRestore();
    }
    // The real write is the atomic one: it leaves the whole file and nothing beside it.
    const dir = dataDir();
    stampDataFormat(dir, "0.1.152");
    expect(readdirSync(dir)).toEqual([DATA_FORMAT_FILE]);
  });

  it("lets the Admin roll a Cloud back one image, and forward again, on the same data", () => {
    const dir = dataDir();
    stampDataFormat(dir, VERSION, DATA_FORMAT);
    const stamped = readFileSync(join(dir, DATA_FORMAT_FILE), "utf8");
    // The image before: the last release, with the numbers it was released with.
    expect(() => checkDataFormat(dir, `${released.version}-previous`, released.reads, released.writes)).not.toThrow();
    stampDataFormat(dir, `${released.version}-previous`, released);
    expect(readFileSync(join(dir, DATA_FORMAT_FILE), "utf8")).toBe(stamped);
    stampDataFormat(dir, VERSION, DATA_FORMAT);
    expect(readFileSync(join(dir, DATA_FORMAT_FILE), "utf8")).toBe(stamped);
  });
});

describe("a server starting on a data folder", () => {
  /** The real server on `dir`, until it exits or `until` holds. */
  async function start(dir: string, until: () => boolean): Promise<{ code: number | null; stderr: string }> {
    const child = spawn(process.execPath, [join(import.meta.dirname, "index.ts")], {
      cwd: ROOT,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: dir, USERPROFILE: dir, OMB_DATA_DIR: join(dir, "data"), OMB_PORT: String(await freePortBlock([0, 1])),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
    const watch = setInterval(() => { if (until()) child.kill("SIGTERM"); }, 50);
    try {
      return { code: await exited, stderr };
    } finally {
      clearInterval(watch);
    }
  }

  it("exits with the one plain line, and creates nothing, when a newer version wrote the data", async () => {
    const dir = dataDir();
    const data = join(dir, "data");
    mkdirSync(data);
    writeFileSync(join(data, DATA_FORMAT_FILE), JSON.stringify({ format: DATA_FORMAT.reads + 1, writtenBy: "99.0.0", writtenAt: "2027-01-01T00:00:00.000Z" }));
    const { code, stderr } = await start(dir, () => false);
    expect(code).toBe(1);
    expect(stderr.trim().split("\n").at(-1)).toBe(
      `OpenMausBot startup failed: the data in ${data} was written by a newer OpenMausBot (99.0.0), in a format this version (${VERSION}) cannot read. Nothing was changed. Install OpenMausBot 99.0.0 or newer, or put back the copy of the data taken before that update.`,
    );
    expect(readdirSync(data)).toEqual([DATA_FORMAT_FILE]);
  }, 60_000);

  it("starts, and puts a good marker back, on a marker a power loss left empty or full of NULs", async () => {
    for (const text of ["", "\0".repeat(64)]) {
      const dir = dataDir();
      const data = join(dir, "data");
      mkdirSync(data);
      writeFileSync(join(data, DATA_FORMAT_FILE), text);
      const marker = join(data, DATA_FORMAT_FILE);
      const { stderr } = await start(dir, () => existsSync(join(data, "environment-id")) && readFileSync(marker, "utf8").includes('"format"'));
      expect(stderr).not.toContain("startup failed");
      expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({ format: DATA_FORMAT.writes, writtenBy: VERSION });
    }
  }, 120_000);

  it("starts on data the next version marked, as after the Admin rolls a Cloud back one image", async () => {
    const dir = dataDir();
    const data = join(dir, "data");
    mkdirSync(data);
    const marker = `${JSON.stringify({ format: DATA_FORMAT.writes, writtenBy: "99.0.0", writtenAt: "2027-01-01T00:00:00.000Z" }, null, 2)}\n`;
    writeFileSync(join(data, DATA_FORMAT_FILE), marker);
    const { stderr } = await start(dir, () => existsSync(join(data, "environment-id")));
    expect(stderr).not.toContain("startup failed");
    expect(readFileSync(join(data, DATA_FORMAT_FILE), "utf8")).toBe(marker);
  }, 60_000);

  it("marks a new data folder with the format it writes", async () => {
    const dir = dataDir();
    const marker = join(dir, "data", DATA_FORMAT_FILE);
    await start(dir, () => existsSync(marker));
    expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({ format: DATA_FORMAT.writes, writtenBy: VERSION });
  }, 60_000);
});

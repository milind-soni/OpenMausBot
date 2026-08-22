import { gzipSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseLinuxCuaArchive,
  readBoundedResponseBody,
  sha256,
  stageLinuxCua,
  validateStagedLayout,
} from "./cua-linux-release.mjs";

const BLOCK = 512;
const temporaryDirectories = [];

function temporaryProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omb-cua-stage-test-"));
  temporaryDirectories.push(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { "@trycua/cua-driver": "0.20.0" } }),
  );
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function entry(name, bytes = Buffer.alloc(0), { type = "0", link = "", mode = 0o755 } = {}) {
  bytes = Buffer.from(bytes);
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, "utf8");
  header.write(octal(mode, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(bytes.length, 12), 124, 12, "ascii");
  header.write(octal(0, 12), 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write(link, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "binary");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc(Math.ceil(bytes.length / BLOCK) * BLOCK - bytes.length);
  return Buffer.concat([header, bytes, padding]);
}

function fixture(entries) {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(BLOCK * 2)]), { mtime: 0 });
}

function contract(archive, members, overrides = {}) {
  return {
    archiveSha256: sha256(archive),
    maxArchiveBytes: 64 * 1024,
    maxExpandedBytes: 128 * 1024,
    ...overrides,
    members,
  };
}

function fileContract(bytes, staged = true) {
  return { kind: "file", size: bytes.length, sha256: sha256(bytes), staged };
}

describe("Linux CUA release staging", () => {
  it("extracts only explicitly staged regular files from an exact reviewed archive", () => {
    const driver = Buffer.from("driver");
    const ignoredSdk = Buffer.from("unused sdk");
    const archive = fixture([
      entry("cua-driver", driver),
      entry("sdk.so", ignoredSdk),
      entry("helper/", Buffer.alloc(0), { type: "5" }),
    ]);
    const members = {
      "cua-driver": fileContract(driver),
      "sdk.so": fileContract(ignoredSdk, false),
      "helper/": { kind: "directory", size: 0 },
    };
    const extracted = parseLinuxCuaArchive(archive, contract(archive, members), members);
    expect([...extracted]).toEqual([["cua-driver", driver]]);
  });

  it("rejects a checksum mismatch before decompression", () => {
    const archive = fixture([entry("cua-driver", "driver")]);
    const members = { "cua-driver": fileContract(Buffer.from("driver")) };
    const changed = Buffer.from(archive);
    changed[changed.length - 1] ^= 1;
    expect(() => parseLinuxCuaArchive(changed, contract(archive, members), members)).toThrow(
      "archive checksum mismatch",
    );
  });

  it.each([
    ["a traversal path", "../cua-driver", "0", "unsafe CUA archive path"],
    ["an absolute path", "/cua-driver", "0", "unsafe CUA archive path"],
    ["a symlink", "cua-driver", "2", "unsupported CUA archive member type"],
    ["a hardlink", "cua-driver", "1", "unsupported CUA archive member type"],
    ["a FIFO", "cua-driver", "6", "unsupported CUA archive member type"],
    ["a device", "cua-driver", "3", "unsupported CUA archive member type"],
  ])("rejects %s", (_label, name, type, message) => {
    const bytes = Buffer.from("driver");
    const archive = fixture([entry(name, bytes, { type, link: type === "2" ? "/tmp/evil" : "" })]);
    const members = { [name]: fileContract(bytes) };
    expect(() => parseLinuxCuaArchive(archive, contract(archive, members), members)).toThrow(message);
  });

  it("rejects duplicate and unknown members", () => {
    const bytes = Buffer.from("driver");
    const duplicate = fixture([entry("cua-driver", bytes), entry("cua-driver", bytes)]);
    const members = { "cua-driver": fileContract(bytes) };
    expect(() => parseLinuxCuaArchive(duplicate, contract(duplicate, members), members)).toThrow(
      "duplicate CUA archive member",
    );

    const unknown = fixture([entry("surprise", bytes)]);
    expect(() => parseLinuxCuaArchive(unknown, contract(unknown, members), members)).toThrow(
      "unexpected CUA archive member",
    );
  });

  it("rejects missing members and mismatched inner hashes", () => {
    const bytes = Buffer.from("driver");
    const missing = fixture([entry("cua-driver", bytes)]);
    const members = {
      "cua-driver": fileContract(bytes),
      "cua-cursor-theme": fileContract(Buffer.from("theme")),
    };
    expect(() => parseLinuxCuaArchive(missing, contract(missing, members), members)).toThrow(
      "missing reviewed member",
    );

    const changed = fixture([entry("cua-driver", bytes)]);
    const wrongInnerHash = {
      "cua-driver": { ...fileContract(bytes), sha256: sha256(Buffer.from("different")) },
    };
    expect(() =>
      parseLinuxCuaArchive(changed, contract(changed, wrongInnerHash), wrongInnerHash),
    ).toThrow("member checksum mismatch");
  });

  it("bounds expanded archive bytes", () => {
    const bytes = Buffer.alloc(4_096, 0x61);
    const archive = fixture([entry("cua-driver", bytes)]);
    const members = { "cua-driver": fileContract(bytes) };
    expect(() =>
      parseLinuxCuaArchive(
        archive,
        contract(archive, members, { maxExpandedBytes: 1_024 }),
        members,
      ),
    ).toThrow("decompressed safely");
  });

  it("bounds both declared and streamed download sizes", async () => {
    const declared = new Response("small", { headers: { "content-length": "100" } });
    await expect(readBoundedResponseBody(declared, 5)).rejects.toThrow("compressed size limit");

    const streamed = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from("1234"));
          controller.enqueue(Buffer.from("5678"));
          controller.close();
        },
      }),
    );
    await expect(readBoundedResponseBody(streamed, 7)).rejects.toThrow("compressed size limit");
  });

  it("rejects unsupported build platforms before reading project state", async () => {
    await expect(
      stageLinuxCua({ rootDirectory: "/not/read", platform: "darwin", arch: "arm64" }),
    ).rejects.toThrow("supports only linux/x64");
    await expect(
      stageLinuxCua({ rootDirectory: "/not/read", platform: "linux", arch: "arm64" }),
    ).rejects.toThrow("supports only linux/x64");
  });

  it("leaves an existing stage untouched when archive verification fails", async () => {
    const root = temporaryProject();
    const stage = path.join(root, "dist-native", "cua-linux-x64");
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, "marker"), "previous valid stage");
    const archive = path.join(root, "corrupt.tar.gz");
    fs.writeFileSync(archive, "not the pinned archive");

    await expect(
      stageLinuxCua({ rootDirectory: root, platform: "linux", arch: "x64", archivePath: archive }),
    ).rejects.toThrow("checksum mismatch");
    expect(fs.readFileSync(path.join(stage, "marker"), "utf8")).toBe("previous valid stage");
  });

  it("never calls fetch in offline mode and rejects an unverified cache", async () => {
    const root = temporaryProject();
    const cache = path.join(
      root,
      "node_modules",
      ".cache",
      "openmausbot",
      "cua-driver-rs-0.19.3-linux-x86_64-binary.tar.gz",
    );
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, "cua-driver 0.19.3 but not the release bytes");
    const fetchImpl = vi.fn();

    await expect(
      stageLinuxCua({
        rootDirectory: root,
        platform: "linux",
        arch: "x64",
        offline: true,
        fetchImpl,
      }),
    ).rejects.toThrow("offline CUA staging requires an existing verified stage or archive cache");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds a stalled upstream download", async () => {
    const root = temporaryProject();
    const fetchImpl = vi.fn((_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    );
    await expect(
      stageLinuxCua({
        rootDirectory: root,
        platform: "linux",
        arch: "x64",
        fetchImpl,
        downloadTimeoutMs: 10,
      }),
    ).rejects.toThrow("download timed out");
  });

  it.skipIf(process.platform === "win32")(
    "accepts only the exact staged tree and safe directory modes",
    async () => {
      const root = temporaryProject();
      const stage = path.join(root, "stage");
      const licenses = path.join(stage, "licenses");
      fs.mkdirSync(licenses, { recursive: true, mode: 0o755 });
      fs.chmodSync(stage, 0o755);
      fs.chmodSync(licenses, 0o755);
      for (const name of ["cua-driver", "cua-cursor-theme", "release.json"]) {
        fs.writeFileSync(path.join(stage, name), "fixture");
      }
      for (const name of [
        "LICENSE.md",
        "Inter-OFL-1.1.txt",
        "THIRD_PARTY_LICENSES.html",
        "THIRD_PARTY_NOTICES.md",
        "SBOM.cdx.json",
      ]) {
        fs.writeFileSync(path.join(licenses, name), "fixture");
      }

      await expect(validateStagedLayout(stage)).resolves.toEqual({ licensesDirectory: licenses });

      fs.writeFileSync(path.join(stage, "unexpected.so"), "payload");
      await expect(validateStagedLayout(stage)).rejects.toThrow("unexpected or missing entries");
      fs.rmSync(path.join(stage, "unexpected.so"));
      fs.chmodSync(licenses, 0o775);
      await expect(validateStagedLayout(stage)).rejects.toThrow("real 0755 directory");
    },
  );
});

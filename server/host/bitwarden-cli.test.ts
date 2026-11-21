import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildZip } from "../testing/zip-fixture.ts";
import { BITWARDEN_CLI_VERSION, BitwardenCliUnavailable, bitwardenCliPath, bitwardenCliPin, bitwardenCliUrl, bitwardenRunner, installBitwardenCli } from "./bitwarden-cli.ts";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "omb-bitwarden-cli-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const TOOL = "#!/bin/sh\necho fake bw\n";
const ARCHIVE = buildZip([{ name: "bw", data: TOOL, mode: 0o100755 }]);
const PIN = { asset: "bw-oss-test", bytes: ARCHIVE.length, sha256: createHash("sha256").update(ARCHIVE).digest("hex"), executable: "bw" };
const serve = (body: Buffer, seen: string[] = []) => (async (url: string) => { seen.push(String(url)); return new Response(new Uint8Array(body), { headers: { "content-length": String(body.length) } }); }) as unknown as typeof fetch;

describe("Bitwarden's command line tool, fetched on first use", () => {
  it("is the open-source build of a pinned release, from Bitwarden's own GitHub releases, for each platform it publishes", () => {
    expect(BITWARDEN_CLI_VERSION).toBe("2026.10.1");
    expect(bitwardenCliUrl(bitwardenCliPin("linux", "x64")!)).toBe("https://github.com/bitwarden/clients/releases/download/cli-v2026.10.1/bw-oss-linux-2026.10.1.zip");
    for (const [platform, arch, asset] of [["darwin", "arm64", "bw-oss-macos-arm64"], ["darwin", "x64", "bw-oss-macos"], ["linux", "arm64", "bw-oss-linux-arm64"], ["win32", "x64", "bw-oss-windows"]] as const) {
      const pin = bitwardenCliPin(platform, arch)!;
      expect(pin.asset).toBe(asset);
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(pin.executable).toBe(platform === "win32" ? "bw.exe" : "bw");
    }
    expect(bitwardenCliPin("win32", "arm64")).toBeNull();
  });

  it("downloads once, checks its SHA-256, and puts only the tool in the data folder", async () => {
    const dataDir = temp(), seen: string[] = [];
    const path = await installBitwardenCli({ dataDir, pin: PIN, fetchImpl: serve(ARCHIVE, seen), url: "https://example.test/bw.zip" });
    expect(path).toBe(bitwardenCliPath(dataDir, PIN));
    expect(path).toBe(join(dataDir, "tools", "bitwarden", BITWARDEN_CLI_VERSION, "bw"));
    expect(readFileSync(path, "utf8")).toBe(TOOL);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(await installBitwardenCli({ dataDir, pin: PIN, fetchImpl: serve(ARCHIVE, seen) })).toBe(path);
    expect(seen).toEqual(["https://example.test/bw.zip"]);
  });

  it("installs nothing from a download that fails its checksum or holds no tool", async () => {
    const dataDir = temp();
    const tampered = Buffer.from(ARCHIVE);
    tampered[tampered.length - 30] ^= 1;
    await expect(installBitwardenCli({ dataDir, pin: PIN, fetchImpl: serve(tampered) })).rejects.toThrow(BitwardenCliUnavailable);
    await expect(installBitwardenCli({ dataDir, pin: PIN, fetchImpl: serve(tampered) })).rejects.toThrow("SHA-256");
    const empty = buildZip([{ name: "README.txt", data: "no tool here" }]);
    await expect(installBitwardenCli({ dataDir, pin: { ...PIN, bytes: empty.length, sha256: createHash("sha256").update(empty).digest("hex") }, fetchImpl: serve(empty) }))
      .rejects.toThrow("did not hold the tool");
    expect(existsSync(bitwardenCliPath(dataDir, PIN))).toBe(false);
    await expect(installBitwardenCli({ dataDir, pin: null })).rejects.toThrow("Bitwarden publishes none");
  });

  it.skipIf(process.platform === "win32")("runs it as a separate process with secrets in its environment only, and none of the server's own", async () => {
    const dir = temp();
    const tool = join(dir, "bw");
    writeFileSync(tool, `#!/bin/sh\necho "args=$*"\necho "secret=$BW_PASSWORD"\necho "dir=$BITWARDENCLI_APPDATA_DIR"\necho "server=$OMB_FAKE_SERVER_SECRET"\nexit 3\n`, { mode: 0o755 });
    process.env.OMB_FAKE_SERVER_SECRET = "never-passed";
    try {
      const run = bitwardenRunner({ executable: async () => tool, appDataDir: join(dir, "account") });
      const result = await run(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], { BW_PASSWORD: "fake-master" });
      expect(result).toEqual({ code: 3, timedOut: false, stderr: "",
        stdout: `args=unlock --passwordenv BW_PASSWORD --raw\nsecret=fake-master\ndir=${join(dir, "account")}\nserver=\n` });
      const missing = bitwardenRunner({ executable: async () => join(dir, "nothing"), appDataDir: join(dir, "account") });
      expect((await missing(["status"])).code).toBe(127);
    } finally {
      delete process.env.OMB_FAKE_SERVER_SECRET;
    }
  });
});

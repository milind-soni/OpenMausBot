import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CADDY_ASSETS, CADDY_VERSION, caddyfileFor, ensureCaddy, normalizeDomainOption, pinnedCaddyPath, portPermissionRefused, resolveCaddyBinary, startCaddy } from "./caddy.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const posix = process.platform !== "win32";

describe("the managed Caddy", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-caddy-"));
  });
  afterEach(() => removeTempDir(dir));

  it("pins one release per platform with a sha512 from the release's checksums", () => {
    for (const [target, asset] of Object.entries(CADDY_ASSETS)) {
      expect(asset.name).toContain(CADDY_VERSION);
      expect(asset.sha512, target).toMatch(/^[0-9a-f]{128}$/);
    }
    expect(pinnedCaddyPath(dir, "linux", "x64")).toBe(join(dir, "caddy", `${CADDY_VERSION}-linux-x64`, "caddy"));
  });

  it("writes the Docker stack's Caddyfile with this server's ports and no admin API", () => {
    const file = caddyfileFor({ domain: "maus.example.com", appPort: 18799, webhookPort: 18800 });
    expect(file).toContain("maus.example.com {");
    expect(file).toContain("reverse_proxy 127.0.0.1:18799");
    expect(file).toContain("handle /hooks/*");
    expect(file).toContain("reverse_proxy 127.0.0.1:18800");
    expect(file).toContain("flush_interval -1");
    expect(file).toContain("admin off");
  });

  it("resolves OMB_CADDY_PATH, then the pinned download, then PATH", () => {
    const pinned = pinnedCaddyPath(dir, "linux", "x64");
    const onPath = join(dir, "bin", "caddy");
    const exists = (p: string) => p === pinned || p === onPath || p === join(dir, "custom");
    expect(resolveCaddyBinary({ dataDir: dir, env: { OMB_CADDY_PATH: join(dir, "custom") }, platform: "linux", arch: "x64", exists })).toBe(join(dir, "custom"));
    expect(resolveCaddyBinary({ dataDir: dir, env: { OMB_CADDY_PATH: "relative/caddy" }, platform: "linux", arch: "x64", exists })).toBeNull();
    expect(resolveCaddyBinary({ dataDir: dir, env: { PATH: join(dir, "bin") }, platform: "linux", arch: "x64", exists })).toBe(pinned);
    expect(resolveCaddyBinary({ dataDir: join(dir, "elsewhere"), env: { PATH: join(dir, "bin") }, platform: "linux", arch: "x64", exists })).toBe(onPath);
    expect(resolveCaddyBinary({ dataDir: join(dir, "elsewhere"), env: { PATH: "" }, platform: "linux", arch: "x64", exists })).toBeNull();
  });

  it("takes a bare public hostname for --domain", () => {
    expect(normalizeDomainOption(" HTTPS://Maus.Example.com/ ")).toBe("maus.example.com");
    expect(normalizeDomainOption("maus.example.com:443")).toEqual({ error: expect.stringContaining("bare hostname") });
    expect(normalizeDomainOption("localhost")).toEqual({ error: expect.stringContaining("bare hostname") });
    expect(normalizeDomainOption("box.internal")).toEqual({ error: expect.stringContaining("public domain") });
    expect(normalizeDomainOption("nodots")).toEqual({ error: expect.stringContaining("bare hostname") });
  });

  it.skipIf(!posix)("downloads a pinned archive once, verifies its digest, and extracts the binary", async () => {
    const src = join(dir, "src");
    mkdirSync(src);
    writeFileSync(join(src, "caddy"), "#!/bin/sh\necho fake caddy\n", { mode: 0o755 });
    const archive = join(dir, "caddy_test_linux_amd64.tar.gz");
    expect(spawnSync("tar", ["-czf", archive, "-C", src, "caddy"]).status).toBe(0);
    const bytes = readFileSync(archive);
    const sha512 = createHash("sha512").update(bytes).digest("hex");
    let fetched = 0;
    const fetchImpl = (async () => {
      fetched += 1;
      return new Response(bytes, { status: 200 });
    }) as unknown as typeof fetch;
    const dataDir = join(dir, "data");
    const binary = await ensureCaddy({ dataDir, env: { PATH: "" }, platform: "linux", arch: "x64", asset: { name: "caddy_test_linux_amd64.tar.gz", sha512, url: "https://stub.invalid/caddy.tgz" }, fetchImpl });
    expect(binary).toBe(pinnedCaddyPath(dataDir, "linux", "x64"));
    expect(existsSync(binary)).toBe(true);
    expect(statSync(binary).mode & 0o111).not.toBe(0);
    expect(fetched).toBe(1);
    expect(await ensureCaddy({ dataDir, env: { PATH: "" }, platform: "linux", arch: "x64", fetchImpl })).toBe(binary);
    expect(fetched).toBe(1);
    const other = join(dir, "data2");
    await expect(ensureCaddy({ dataDir: other, env: { PATH: "" }, platform: "linux", arch: "x64", asset: { name: "caddy_test_linux_amd64.tar.gz", sha512: "0".repeat(128), url: "https://stub.invalid/x" }, fetchImpl })).rejects.toThrow(/SHA-512/);
    expect(existsSync(pinnedCaddyPath(other, "linux", "x64"))).toBe(false);
  });

  it.skipIf(!posix)("runs Caddy with the written Caddyfile and stops it; a port refusal becomes the privilege hint", async () => {
    const fake = join(dir, "fake-caddy");
    writeFileSync(fake, `#!/bin/sh\necho "$@" > "${join(dir, "args.txt")}"\nexec sleep 300\n`, { mode: 0o755 });
    chmodSync(fake, 0o755);
    const running = await startCaddy({ binary: fake, dataDir: dir, domain: "maus.example.com", appPort: 18799, webhookPort: 18800, settleMs: 300 });
    try {
      // the stand-in writes its arguments from a shell that may start slowly under load
      await expect.poll(() => existsSync(join(dir, "args.txt")), { timeout: 5_000 }).toBe(true);
      expect(readFileSync(join(dir, "args.txt"), "utf8").trim()).toBe(`run --config ${running.configFile} --adapter caddyfile`);
      expect(readFileSync(running.configFile, "utf8")).toContain("reverse_proxy 127.0.0.1:18799");
      expect(statSync(running.configFile).mode & 0o077).toBe(0);
    } finally {
      await running.stop();
    }
    expect(await running.exited).not.toBeUndefined();

    const refusing = join(dir, "refusing-caddy");
    writeFileSync(refusing, "#!/bin/sh\necho 'Error: loading initial config: listen tcp :443: bind: permission denied' >&2\nexit 1\n", { mode: 0o755 });
    await expect(startCaddy({ binary: refusing, dataDir: join(dir, "d2"), domain: "maus.example.com", appPort: 1, webhookPort: 2, settleMs: 2000 })).rejects.toThrow(/ports 80 and 443/);
    expect(portPermissionRefused("listen tcp :443: bind: permission denied")).toBe(true);
    expect(portPermissionRefused("some other error")).toBe(false);
  });
});

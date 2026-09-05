import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { formatSessions, pairingBlock, parseArgs, qrToString, serverEntry } from "./cli.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

describe("openmausbot command line", () => {
  it("parses commands and flags, and explains mistakes", () => {
    const serve = parseArgs(["serve", "--port", "9001", "--data-dir", "/tmp/x", "--label", "cab mini", "--tailscale", "--no-pair"], {});
    // --data-dir is resolved against the platform: C:\tmp\x on Windows.
    expect(serve).toMatchObject({ command: "serve", port: 9001, dataDir: resolve("/tmp/x"), label: "cab mini", tailscale: true, pair: false });
    expect(parseArgs(["pair", "--client", "--public-url", "https://h/"], {})).toMatchObject({ command: "pair", client: true, publicUrl: "https://h" });
    expect(parseArgs(["sessions", "revoke", "abc"], {})).toMatchObject({ command: "sessions", revoke: "abc" });
    expect(parseArgs([], { OMB_PORT: "8123" })).toMatchObject({ command: "help", port: 8123 });
    expect(parseArgs(["dance"], {})).toEqual({ error: 'unknown command "dance"' });
    expect(parseArgs(["serve", "--port"], {})).toEqual({ error: "--port needs a value" });
    expect(parseArgs(["serve", "--port", "70000"], {})).toEqual({ error: "--port must be 1-65535" });
    expect(parseArgs(["pair", "--public-url", "mini.example"], {})).toEqual({ error: "--public-url must start with http:// or https://" });
    expect(parseArgs(["serve", "--bogus"], {})).toEqual({ error: 'unknown argument "--bogus"' });
  });

  it("prints a scannable block with the link, or says where to type the code", () => {
    const block = pairingBlock({ code: "ABCD-EFGH-JKLM", url: "https://mini.example/pair#code=ABCD-EFGH-JKLM", expiresAt: Date.now() + 60_000 });
    expect(block).toContain("pairing code:  ABCD-EFGH-JKLM");
    expect(block).toContain("open or scan:  https://mini.example/pair#code=ABCD-EFGH-JKLM");
    expect(block).toMatch(/[▀▄█]/);
    const noUrl = pairingBlock({ code: "ABCD-EFGH-JKLM", url: null, expiresAt: Date.now(), hint: "set OMB_PUBLIC_URL" });
    expect(noUrl).toContain("/pair on the address you use");
    expect(noUrl).toContain("set OMB_PUBLIC_URL");
    expect(qrToString("https://example.com").length).toBeGreaterThan(200);
  });

  it("lists sessions as a table with relative last-seen times", () => {
    const now = Date.parse("2026-09-05T12:00:00Z");
    const table = formatSessions([
      { id: "a1", label: "My MacBook", scopes: ["admin", "client"], lastSeenAt: now - 30_000, expiresAt: now + 86_400_000 },
      { id: "b2", label: "", scopes: ["client"], lastSeenAt: now - 3 * 3_600_000, expiresAt: now + 86_400_000 },
    ], now);
    expect(table).toContain("My MacBook");
    expect(table).toContain("(unnamed)");
    expect(table).toMatch(/a1\s+My MacBook\s+admin\s+just now/);
    expect(table).toMatch(/b2\s+\(unnamed\)\s+client\s+3 h ago/);
    expect(table).toContain("sessions revoke <id>");
  });

  it("finds the server next to itself: bundled index.js in a package, the TypeScript source in a checkout", () => {
    const checkout = serverEntry(SERVER_DIR);
    expect(checkout.args[0]).toBe("--experimental-strip-types");
    expect(checkout.args[1]).toBe(join(SERVER_DIR, "index.ts"));
    expect(checkout.skillsDir).toBe(join(SERVER_DIR, "..", "skills"));
  });

  it("serve: starts the server, prints the pairing link, and stops on SIGTERM", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-cli-serve-"));
    const port = 21000 + Math.floor(Math.random() * 9000);
    const child = spawn(process.execPath, ["--experimental-strip-types", join(SERVER_DIR, "openmausbot.ts"), "serve", "--port", String(port), "--data-dir", join(home, "data"), "--label", "cli test", "--public-url", "https://mini.example"], {
      cwd: join(SERVER_DIR, ".."),
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, OMB_WEBHOOK_PORT: String(port + 1), OMB_BROWSER_CONNECTION: join(home, "browser-connection.json") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += String(c)));
    child.stderr.on("data", (c) => (out += String(c)));
    try {
      const deadline = Date.now() + 60_000;
      while (!out.includes("open or scan:") && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 200));
      expect(out).toContain(`OpenMausBot is running on http://127.0.0.1:${port}, reachable at https://mini.example`);
      expect(out).toMatch(/pairing code:  [A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
      expect(out).toContain("open or scan:  https://mini.example/pair#code=");
      expect(out).toMatch(/[▀▄█]/);
      const descriptor: any = await (await fetch(`http://127.0.0.1:${port}/.well-known/openmausbot/environment`)).json();
      expect(descriptor.label).toBe("cli test");
      const pairing: any = await (await fetch(`http://127.0.0.1:${port}/api/auth/pairing`)).json();
      expect(pairing.pairings.length).toBeGreaterThanOrEqual(1);
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child, { signal: "SIGTERM" });
      await removeTempDir(home);
    }
    let dead = false;
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`);
    } catch {
      dead = true;
    }
    expect(dead).toBe(true);
  }, 90_000);
});

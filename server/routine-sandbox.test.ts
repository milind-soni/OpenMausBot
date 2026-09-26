import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  abortAllScriptedRoutineRuns,
  CANARY_ENV_ALLOWED,
  deniedRangeFor,
  FramedLineReader,
  loadScriptedRoutineScript,
  normalizeResolvedAddress,
  probeScriptedRuntime,
  runScriptedRoutine,
  type ScriptedRoutineAllowlistEntry,
  type ScriptedRoutineScript,
  type ScriptedRoutineRunOptions,
  type ScriptedRunOutcome,
} from "./routine-sandbox.ts";

let stateRoot = "";
const servers: http.Server[] = [];

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "omb-sandbox-state-"));
});

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    void server.close();
  }
  rmSync(stateRoot, { recursive: true, force: true });
});

function makeScript(source: string, overrides: Partial<ScriptedRoutineScript> = {}): ScriptedRoutineScript {
  return {
    source,
    version: createHash("sha256").update(source, "utf8").digest("hex"),
    reviewState: "approved",
    ...overrides,
  };
}

interface RecordedHit {
  url: string;
  method: string;
  headers: http.IncomingHttpHeaders;
}

function startServer(handler: http.RequestListener): Promise<{ port: number; hits: RecordedHit[] }> {
  const hits: RecordedHit[] = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url ?? "/", method: req.method ?? "GET", headers: req.headers });
    handler(req, res);
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ port: typeof address === "object" && address !== null ? address.port : 0, hits });
    });
  });
}

function allowlistEntry(overrides: Partial<ScriptedRoutineAllowlistEntry> = {}): ScriptedRoutineAllowlistEntry {
  return { host: "api.local.test", scheme: "http", allow: ["loopback"], ...overrides };
}

function plainEntry(overrides: Partial<ScriptedRoutineAllowlistEntry> = {}): ScriptedRoutineAllowlistEntry {
  return { host: "api.local.test", scheme: "http", ...overrides };
}

async function run(
  script: ScriptedRoutineScript,
  options: ScriptedRoutineRunOptions = {},
  routineId = "test-routine",
): Promise<ScriptedRunOutcome> {
  return await runScriptedRoutine(
    { id: routineId, script },
    { stateDir: stateRoot, resolveDns: async () => ["127.0.0.1"], ...options },
  );
}

function scriptTarget(port: number, path: string): string {
  return "http://api.local.test:" + port + path;
}

describe("scripted routine sandbox runtime", () => {
  describe("runtime canary", () => {
    it("reports every neutering check green in the plain Node server parent", { timeout: 30_000 }, async () => {
      const canary = await probeScriptedRuntime();
      if (!canary.ok) throw new Error("canary failed: " + canary.detail);
      expect(canary.result.checks).toMatchObject({
        process_internals_throw: true,
        fs_denied: true,
        spawn_denied: true,
        net_denied: true,
        fetch_denied: true,
        dynamic_import_blocked: true,
        eval_removed: true,
        function_removed: true,
        wasm_removed: true,
        process_removed: true,
        require_removed: true,
      });
      expect(canary.result.envKeys.every((key) => CANARY_ENV_ALLOWED.has(key))).toBe(true);
    });

    it("scrubs inherited NODE_OPTIONS so the permission fence cannot be dissolved", { timeout: 30_000 }, async () => {
      const previous = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = "--allow-fs-read=/";
      try {
        const canary = await probeScriptedRuntime();
        expect(canary.ok).toBe(true);
        expect(canary.result?.envKeys).not.toContain("NODE_OPTIONS");
      } finally {
        if (previous === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = previous;
      }
    });
  });

  describe("FramedLineReader", () => {
    it("enforces the line cap while buffering a newline-less flood", () => {
      let lines = 0;
      let overflows = 0;
      const reader = new FramedLineReader(16, () => lines++, () => overflows++);
      reader.push(Buffer.from("0123456789abcdefghij"));
      expect(overflows).toBe(1);
      reader.push(Buffer.from("more-bytes"));
      expect(overflows).toBe(1);
      expect(lines).toBe(0);
    });

    it("accepts a line exactly at the cap and rejects one byte over", () => {
      const lines: string[] = [];
      let overflows = 0;
      const reader = new FramedLineReader(16, (line) => lines.push(line), () => overflows++);
      reader.push(Buffer.from("0123456789abcdef\n"));
      reader.push(Buffer.from("0123456789abcdefg"));
      expect(lines).toEqual(["0123456789abcdef"]);
      expect(overflows).toBe(1);
    });
  });

  describe("address normalization and range classification", () => {
    it.each([
      ["::ffff:127.0.0.1", "127.0.0.1"],
      ["::FFFF:7f00:1", "127.0.0.1"],
      ["FE80::1%EN0", "fe80::1"],
      ["[::1]", "::1"],
      ["  10.0.0.1 ", "10.0.0.1"],
    ])("normalizes %s to %s", (input, expected) => {
      expect(normalizeResolvedAddress(input)).toBe(expected);
    });

    it.each([
      ["127.0.0.1", "loopback"],
      ["::1", "loopback"],
      ["::", "unspecified"],
      ["0.0.0.0", "unspecified"],
      ["10.1.2.3", "private"],
      ["172.16.0.1", "private"],
      ["192.168.0.1", "private"],
      ["fd12::1", "private"],
      ["fe80::1", "link_local"],
      ["169.254.1.1", "link_local"],
      ["169.254.169.254", "cloud_metadata"],
      ["100.64.0.1", "cgnat"],
      ["224.0.0.9", "multicast"],
      ["ff02::1", "multicast"],
      ["198.18.0.1", "benchmark"],
      ["8.8.8.8", null],
      ["172.32.0.1", null],
    ])("classifies %s as %s", (address, expected) => {
      expect(deniedRangeFor(address)).toBe(expected);
    });

    it("lifts only the range an entry explicitly opts into", () => {
      expect(deniedRangeFor("127.0.0.1", ["loopback"])).toBeNull();
      expect(deniedRangeFor("10.0.0.1", ["loopback"])).toBe("private");
    });
  });

  describe("script validation on load", () => {
    const version = createHash("sha256").update("return 1;", "utf8").digest("hex");
    const valid = {
      source: "return 1;",
      version,
      reviewState: "approved" as const,
      networkAllowlist: [{ host: "api.local.test", scheme: "http" as const, port: 8080, allow: ["loopback" as const] }],
    };

    it("accepts a valid definition", () => {
      expect(loadScriptedRoutineScript(valid)).toEqual(valid);
    });

    it("accepts a definition without optional fields", () => {
      expect(loadScriptedRoutineScript({ source: "return 1;", version })).toBeDefined();
    });

    it("accepts an http credential with the loopback transport opt-in", () => {
      const entry = { ...valid.networkAllowlist[0]!, credentialId: "cred-test", allowHttpCredential: true };
      expect(loadScriptedRoutineScript({ ...valid, networkAllowlist: [entry] })).toBeDefined();
    });

    it.each([
      ["a bad version", { ...valid, version: "not-a-hash" }],
      ["an unknown field", { ...valid, extra: true }],
      ["an IP-literal host", { ...valid, networkAllowlist: [{ ...valid.networkAllowlist[0]!, host: "127.0.0.1" }] }],
      ["a wildcard host", { ...valid, networkAllowlist: [{ ...valid.networkAllowlist[0]!, host: "*.example.com" }] }],
      ["a userinfo host", { ...valid, networkAllowlist: [{ ...valid.networkAllowlist[0]!, host: "user@api.local.test" }] }],
      ["an http credential without the transport opt-in", { ...valid, networkAllowlist: [{ ...valid.networkAllowlist[0]!, credentialId: "cred-test" }] }],
      ["too many allowlist entries", { ...valid, networkAllowlist: Array.from({ length: 33 }, () => valid.networkAllowlist[0]!) }],
      ["null", null],
      ["a bare string", "return 1;"],
    ])("defensively drops %s", (_name, value) => {
      expect(loadScriptedRoutineScript(value)).toBeUndefined();
    });
  });

  describe("review gates", () => {
    it("refuses staged scripts and version mismatches before any child spawns", async () => {
      const staged = await run(makeScript("return 1;", { reviewState: "staged" }));
      expect(staged.ok).toBe(false);
      expect(staged.failure?.kind).toBe("policy_violation");
      expect(staged.failure?.detail).toBe("script_not_approved");

      const mismatch = await run(makeScript("return 1;", { version: "0".repeat(64) }));
      expect(mismatch.failure?.kind).toBe("policy_violation");
      expect(mismatch.failure?.detail).toBe("script_version_mismatch");
    });

    it("refuses a routine id that is not a safe state key", { timeout: 30_000 }, async () => {
      const outcome = await run(makeScript("return 1;"), {}, "bad/id");
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("state_error");
      expect(outcome.failure?.detail).toContain("safe state key");
    });
  });

  describe("execution", () => {
    it("returns the script value with logs and a full receipt", { timeout: 30_000 }, async () => {
      const source = 'console.log("hi"); return { n: 1 };';
      const outcome = await run(makeScript(source));
      expect(outcome.ok).toBe(true);
      expect(outcome.value).toEqual({ n: 1 });
      expect(outcome.logs).toEqual(["log hi"]);
      expect(outcome.warnings).toEqual([]);
      expect(outcome.logTruncated).toBe(false);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.deterministic).toBe(true);
      expect(outcome.scriptVersion).toBe(createHash("sha256").update(source, "utf8").digest("hex"));
      expect(outcome.failure).toBeUndefined();
    });

    it("neuters the child surface the script sees", { timeout: 30_000 }, async () => {
      const outcome = await run(makeScript(
        "return JSON.stringify({ process: typeof process, require: typeof require, eval: typeof eval," +
        " functionCtor: typeof Function, wasm: typeof WebAssembly, fetch: typeof fetch," +
        " stateGet: typeof state.get, statePut: typeof state.put });",
      ));
      expect(outcome.ok).toBe(true);
      expect(JSON.parse(outcome.value as string)).toEqual({
        process: "undefined",
        require: "undefined",
        eval: "undefined",
        functionCtor: "undefined",
        wasm: "undefined",
        fetch: "function",
        stateGet: "function",
        statePut: "function",
      });
    });

    it("reports a thrown script error as script_error with exit code 0", { timeout: 30_000 }, async () => {
      const outcome = await run(makeScript('throw new Error("boom");'));
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("script_error");
      expect(outcome.failure?.detail).toContain("boom");
      expect(outcome.exitCode).toBe(0);
    });

    it("blocks the Function constructor reachable through a function's prototype", { timeout: 30_000 }, async () => {
      const outcome = await run(makeScript("return typeof (function () {}).constructor;"));
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("script_error");
      expect(outcome.failure?.detail).toContain("access denied: the Function constructor is neutered");
      expect(outcome.exitCode).toBe(0);
    });

    it("reports a child that exits without a result envelope as a crash", { timeout: 30_000 }, async () => {
      const outcome = await run(makeScript("return 1;"), { bootstrapSource: "process.exit(1);" });
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("crash");
      expect(outcome.failure?.detail).toContain("without a result envelope");
    });
  });

  describe("fetch pipeline", () => {
    it("round-trips a fetch through the reviewed allowlist with sanitized headers", { timeout: 30_000 }, async () => {
      const { port, hits } = await startServer((_req, res) => {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-custom": "yes",
          "set-cookie": "session=secret",
          "www-authenticate": "Basic realm=x",
        });
        res.end(JSON.stringify({ ok: true }));
      });
      const outcome = await run(makeScript(
        "const response = await fetch(" + JSON.stringify(scriptTarget(port, "/data")) + ");" +
        "return { status: response.status, ok: response.ok, body: await response.json(), headers: response.headers, truncated: response.truncated };",
        { networkAllowlist: [allowlistEntry({ port })] },
      ));
      expect(outcome.ok).toBe(true);
      const value = outcome.value as { status: number; ok: boolean; body: unknown; headers: Record<string, string>; truncated: boolean };
      expect(value.status).toBe(200);
      expect(value.ok).toBe(true);
      expect(value.body).toEqual({ ok: true });
      expect(value.truncated).toBe(true);
      expect(value.headers["content-type"]).toBe("application/json");
      expect(value.headers["x-custom"]).toBe("yes");
      expect(value.headers).not.toHaveProperty("set-cookie");
      expect(value.headers).not.toHaveProperty("www-authenticate");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.headers.host).toBe("api.local.test:" + port);
    });

    it("attaches a reviewed credential host-side and never leaks it into the receipt", { timeout: 30_000 }, async () => {
      const { port, hits } = await startServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      });
      const outcome = await run(
        makeScript("await fetch(" + JSON.stringify(scriptTarget(port, "/who")) + "); return 'done';", {
          networkAllowlist: [allowlistEntry({ port, credentialId: "cred-test", allowHttpCredential: true })],
        }),
        { resolveCredential: () => "tok_secret_do_not_leak" },
      );
      expect(outcome.ok).toBe(true);
      expect(hits[0]!.headers.authorization).toBe("Bearer tok_secret_do_not_leak");
      expect(JSON.stringify(outcome)).not.toContain("tok_secret_do_not_leak");
    });

    it("denies a loopback resolution without an entry opt-in", { timeout: 30_000 }, async () => {
      const { port } = await startServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      });
      const outcome = await run(makeScript("await fetch(" + JSON.stringify(scriptTarget(port, "/x")) + "); return 'unreachable';", {
        networkAllowlist: [plainEntry({ port })],
      }));
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("policy_violation");
      expect(outcome.failure?.deniedHost).toBe("api.local.test");
      expect(outcome.failure?.detail).toContain("denied loopback range");
    });

    it("unwraps an IPv4-mapped IPv6 resolution before the range check", { timeout: 30_000 }, async () => {
      const { port } = await startServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      });
      const outcome = await run(
        makeScript("await fetch(" + JSON.stringify(scriptTarget(port, "/x")) + "); return 'unreachable';", {
          networkAllowlist: [plainEntry({ port })],
        }),
        { resolveDns: async () => ["::ffff:127.0.0.1"] },
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("policy_violation");
      expect(outcome.failure?.detail).toContain("denied loopback range");
    });

    it("denies an unlisted host", { timeout: 30_000 }, async () => {
      const { port } = await startServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      });
      const outcome = await run(makeScript("await fetch(" + JSON.stringify("http://other.local.test:" + port + "/x") + "); return 'unreachable';", {
        networkAllowlist: [plainEntry({ port })],
      }));
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("policy_violation");
      expect(outcome.failure?.deniedHost).toBe("other.local.test");
      expect(outcome.failure?.detail).toContain("not in the reviewed network allowlist");
    });

    it("softens an optional fetch denial into a catchable error and a warning", { timeout: 30_000 }, async () => {
      const { port } = await startServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      });
      const outcome = await run(makeScript(
        "try { await fetch(" + JSON.stringify(scriptTarget(port, "/x")) + ", { optional: true }); return 'no-error'; }" +
        " catch (error) { return error.name; }",
        { networkAllowlist: [plainEntry({ port })] },
      ));
      expect(outcome.ok).toBe(true);
      expect(outcome.value).toBe("ScriptedFetchError");
      expect(outcome.warnings[0]).toMatch(/optional fetch denied:/);
    });

    it("turns a DNS failure into a catchable fetch error", { timeout: 30_000 }, async () => {
      const { port } = await startServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      });
      const outcome = await run(
        makeScript(
          "try { await fetch(" + JSON.stringify(scriptTarget(port, "/x")) + "); return 'unreachable'; }" +
          " catch (error) { return error.name; }",
          { networkAllowlist: [allowlistEntry({ port })] },
        ),
        { resolveDns: async () => { throw new Error("ENOTFOUND fixture"); } },
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.value).toBe("ScriptedFetchError");
    });

    it("enforces the concurrent-request budget", { timeout: 30_000 }, async () => {
      const { port, hits } = await startServer(() => { /* never responds */ });
      const outcome = await run(makeScript(
        "await Promise.all(['/h1', '/h2', '/h3', '/h4', '/h5'].map(function (path) {" +
        " return fetch(" + JSON.stringify("http://api.local.test:" + port) + " + path); }));",
        { networkAllowlist: [allowlistEntry({ port })] },
      ));
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("request_limit");
      expect(outcome.failure?.detail).toContain("outstanding (4");
      expect(hits).toHaveLength(4);
    });

    it("enforces the per-run total request budget", { timeout: 30_000 }, async () => {
      const { port, hits } = await startServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      });
      const outcome = await run(makeScript(
        "for (var i = 0; i < 51; i++) { await fetch(" + JSON.stringify("http://api.local.test:" + port) + " + '/t' + i); } return 'done';",
        { networkAllowlist: [allowlistEntry({ port })] },
      ));
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("request_limit");
      expect(outcome.failure?.detail).toContain("total (50");
      expect(hits).toHaveLength(50);
    });

    it("follows a same-host redirect after re-validation", { timeout: 30_000 }, async () => {
      const { port, hits } = await startServer((req, res) => {
        if (req.url === "/a") {
          res.writeHead(302, { location: "/b" });
          res.end();
          return;
        }
        res.writeHead(200);
        res.end("done");
      });
      const outcome = await run(makeScript(
        "const response = await fetch(" + JSON.stringify(scriptTarget(port, "/a")) + ");" +
        "return { status: response.status, body: await response.text() };",
        { networkAllowlist: [allowlistEntry({ port })] },
      ));
      expect(outcome.ok).toBe(true);
      expect(outcome.value).toEqual({ status: 200, body: "done" });
      expect(hits.map((hit) => hit.url)).toEqual(["/a", "/b"]);
    });

    it("denies a cross-host redirect to an unlisted host", { timeout: 30_000 }, async () => {
      const { port } = await startServer((_req, res) => {
        res.writeHead(302, { location: "http://other.local.test:" + port + "/x" });
        res.end();
      });
      const outcome = await run(makeScript(
        "await fetch(" + JSON.stringify(scriptTarget(port, "/a")) + "); return 'unreachable';",
        { networkAllowlist: [allowlistEntry({ port })] },
      ));
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("policy_violation");
      expect(outcome.failure?.deniedHost).toBe("other.local.test");
    });

    it("never rides an authorization across a cross-host redirect", { timeout: 30_000 }, async () => {
      const { port, hits } = await startServer((req, res) => {
        if (req.url === "/a") {
          res.writeHead(302, { location: "http://dest.local.test:" + port + "/final" });
          res.end();
          return;
        }
        res.writeHead(200);
        res.end("ok");
      });
      const outcome = await run(
        makeScript("await fetch(" + JSON.stringify(scriptTarget(port, "/a")) + "); return 'done';", {
          networkAllowlist: [
            allowlistEntry({ port, credentialId: "cred-test", allowHttpCredential: true }),
            { host: "dest.local.test", scheme: "http", port, allow: ["loopback"] },
          ],
        }),
        { resolveCredential: () => "tok_redirect_secret" },
      );
      expect(outcome.ok).toBe(true);
      expect(hits).toHaveLength(2);
      expect(hits[0]!.headers.authorization).toBe("Bearer tok_redirect_secret");
      expect(hits[1]!.headers.authorization).toBeUndefined();
      expect(hits[1]!.url).toBe("/final");
    });

    it("refuses a credential over plain http to a non-loopback address", { timeout: 30_000 }, async () => {
      const outcome = await run(
        makeScript("await fetch(" + JSON.stringify("http://api.local.test/x") + "); return 'unreachable';", {
          networkAllowlist: [allowlistEntry({ credentialId: "cred-test" })],
        }),
        {
          resolveDns: async () => ["93.184.216.34"],
          resolveCredential: () => {
            throw new Error("credential must not resolve before the transport check");
          },
        },
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("policy_violation");
      expect(outcome.failure?.detail).toContain("credential transport requires https or a pinned loopback address");
      expect(outcome.failure?.deniedHost).toBe("api.local.test");
    });

    it("holds the outstanding slot across a whole redirect chain", { timeout: 30_000 }, async () => {
      const { port, hits } = await startServer((req, res) => {
        if (req.url === "/a") {
          res.writeHead(302, { location: "/b" });
          res.end();
          return;
        }
        // /b and the /h* hops never respond: the redirect chain and three
        // plain fetches stay in flight together.
      });
      const outcome = await run(makeScript(
        "var base = " + JSON.stringify("http://api.local.test:" + port) + ";" +
        "fetch(base + '/a');" +
        "fetch(base + '/h1');" +
        "fetch(base + '/h2');" +
        "fetch(base + '/h3');" +
        "await new Promise(function (resolve) { setTimeout(resolve, 250); });" +
        "await fetch(base + '/h4');" +
        "return 'unreachable';",
        { networkAllowlist: [allowlistEntry({ port })] },
      ));
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("request_limit");
      expect(outcome.failure?.detail).toContain("outstanding (4");
      expect(hits.map((hit) => hit.url).sort()).toEqual(["/a", "/b", "/h1", "/h2", "/h3"]);
    });

    it("fails a response over the 2 MiB cap as response_too_large", { timeout: 30_000 }, async () => {
      const { port } = await startServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(3 * 1024 * 1024));
      });
      const outcome = await run(makeScript(
        "await fetch(" + JSON.stringify(scriptTarget(port, "/big")) + "); return 'done';",
        { networkAllowlist: [allowlistEntry({ port })] },
      ));
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("response_too_large");
      expect(outcome.failure?.detail).toContain("2 MiB cap");
    });

    it("round-trips a max-size body whose worst-case JSON escaping exceeds the raw cap on the wire", { timeout: 30_000 }, async () => {
      const { port } = await startServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(Buffer.from(Uint8Array.from({ length: 2 * 1024 * 1024 }, () => 1)));
      });
      const outcome = await run(makeScript(
        "const response = await fetch(" + JSON.stringify(scriptTarget(port, "/escape-heavy")) + ");" +
        "return { status: response.status, length: (await response.text()).length };",
        { networkAllowlist: [allowlistEntry({ port })] },
      ));
      expect(outcome.ok).toBe(true);
      expect(outcome.value).toEqual({ status: 200, length: 2 * 1024 * 1024 });
    });
  });

  describe("state", () => {
    const counter = [
      "const prev = state.get();",
      "const next = { count: (prev && typeof prev.count === 'number' ? prev.count : 0) + 1 };",
      "await state.put(next);",
      "return next.count;",
    ].join(" ");

    it("persists state across runs per routine id with 0600 files", { timeout: 30_000 }, async () => {
      const first = await run(makeScript(counter));
      const second = await run(makeScript(counter));
      const isolated = await run(makeScript(counter), {}, "other-routine");
      expect(first.value).toBe(1);
      expect(second.value).toBe(2);
      expect(isolated.value).toBe(1);
      expect(statSync(join(stateRoot, "test-routine.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(stateRoot, "other-routine.json")).mode & 0o777).toBe(0o600);
    });

    it("refuses a state put over the 64 KiB cap", { timeout: 30_000 }, async () => {
      const outcome = await run(makeScript("await state.put({ blob: 'x'.repeat(70000) }); return 'done';"));
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("state_error");
      expect(outcome.failure?.detail).toContain("cap");
    });

    it("serves a fresh state.get immediately after state.put settles", { timeout: 30_000 }, async () => {
      const outcome = await run(makeScript("await state.put({ x: 1 }); return state.get();"));
      expect(outcome.ok).toBe(true);
      expect(outcome.value).toEqual({ x: 1 });
    });
  });

  describe("runtime limits", () => {
    it("times out a spinning script", { timeout: 30_000 }, async () => {
      const outcome = await run(makeScript("for (;;) {}", { timeoutSeconds: 1 }));
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("timeout");
      expect(outcome.exitCode).toBeNull();
    });

    it("kills a script whose RSS crosses the reviewed limit", { timeout: 30_000 }, async () => {
      const outcome = await run(makeScript(
        "var keep = []; for (var i = 0; i < 800; i++) keep.push(new Array(15625).fill(i));" +
        " await new Promise(function (resolve) { setTimeout(resolve, 8000); }); return 1;",
        { rssLimitBytes: 64 * 1024 * 1024 },
      ));
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("crash");
      expect(outcome.failure?.detail).toContain("rss_limit");
    });

    it("treats the result line as terminal and ignores later shim frames", { timeout: 30_000 }, async () => {
      const { port, hits } = await startServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      });
      const hostile = [
        'const fs = require("node:fs");',
        "process.stdin.resume();",
        'fs.writeSync(1, JSON.stringify({ ok: true, value: 1, logs: [], warnings: [], logTruncated: false }) + "\\n");',
        "setTimeout(function () {",
        "  try {",
            '    fs.writeSync(3, JSON.stringify({ id: 1, type: "fetch", method: "GET", url: ' + JSON.stringify(scriptTarget(port, "/post-result")) + ', headers: {}, body: null }) + "\\n");',
        "  } catch (error) { /* fd closed */ }",
        "}, 150);",
        "setTimeout(function () { process.exit(0); }, 400);",
      ].join("\n");
      const outcome = await run(makeScript("return 1;"), { bootstrapSource: hostile });
      expect(outcome.ok).toBe(true);
      expect(outcome.value).toBe(1);
      expect(hits).toHaveLength(0);
    });

    it("kills a child that keeps running after reporting its result", { timeout: 30_000 }, async () => {
      const hostile = [
        'const fs = require("node:fs");',
        "process.stdin.resume();",
        'fs.writeSync(1, JSON.stringify({ ok: true, value: 2, logs: [], warnings: [], logTruncated: false }) + "\\n");',
        "setInterval(function () {}, 1000);",
      ].join("\n");
      const outcome = await run(makeScript("return 1;"), { bootstrapSource: hostile });
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("crash");
      expect(outcome.failure?.detail).toContain("post_result_linger");
    });

    it("aborts a newline-less flood on the shim channel at the frame cap", { timeout: 30_000 }, async () => {
      const hostile = [
        'const fs = require("node:fs");',
        "process.stdin.resume();",
        'var chunk = new Array(300001).join("x");',
        "for (var i = 0; i < 3; i++) { try { fs.writeSync(3, chunk); } catch (error) { break; } }",
        "setInterval(function () {}, 1000);",
      ].join("\n");
      const outcome = await run(makeScript("return 1;"), { bootstrapSource: hostile });
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("crash");
      expect(outcome.failure?.detail).toContain("shim_frame_limit");
    });

    it("aborts every in-flight run on shutdown and waits for the receipts", { timeout: 30_000 }, async () => {
      const { port } = await startServer(() => { /* never responds */ });
      const pending = run(makeScript(
        "await fetch(" + JSON.stringify(scriptTarget(port, "/hang")) + "); return 'unreachable';",
        { networkAllowlist: [allowlistEntry({ port })], timeoutSeconds: 10 },
      ));
      await new Promise((resolve) => setTimeout(resolve, 400));
      await abortAllScriptedRoutineRuns();
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      expect(outcome.failure?.kind).toBe("crash");
      expect(outcome.failure?.detail).toContain("server_shutdown");
    });
  });
});

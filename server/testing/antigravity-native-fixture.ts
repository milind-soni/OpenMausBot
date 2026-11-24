// A native Antigravity CLI on disk for tests: a program named `antigravity` that runs the fake CLI
// (server/testing/fake-antigravity-cli.ts), and the log that fake writes.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { antigravityRuntimesRoot } from "../engine-roots.ts";
import { spawnCli } from "../procs.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "fake-antigravity-cli.ts");

export interface NativeFixture {
  directory: string;
  executable: string;
  log: string;
  /** Every request and login event the fake logged, in order. */
  entries(): Array<Record<string, any>>;
  /** The ACP methods the fake received. */
  methods(): string[];
}

const shellQuoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const fakeAntigravityScript = () => `#!/bin/sh\nexec ${shellQuoted(process.execPath)} ${shellQuoted(FAKE_CLI)} "$@"\n`;

export function nativeFixture(directory: string): NativeFixture {
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, "antigravity");
  writeFileSync(executable, fakeAntigravityScript());
  chmodSync(executable, 0o755);
  const log = join(directory, "fake-antigravity.log");
  const entries = () => existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>)
    : [];
  return { directory, executable, log, entries, methods: () => entries().flatMap((entry) => typeof entry.method === "string" ? [entry.method] : []) };
}

/** The managed install the app makes under `baseDir`, laid down by hand: the same files, with no download. */
export function installFakeManagedCli(baseDir: string, releaseId = "a".repeat(64), version = "1.5.14"): string {
  const root = join(antigravityRuntimesRoot(baseDir), `${process.platform}-${process.arch}`);
  const directory = join(root, "versions", releaseId);
  mkdirSync(directory, { recursive: true });
  const name = process.platform === "win32" ? "agy.exe" : "antigravity";
  const script = fakeAntigravityScript();
  writeFileSync(join(directory, name), script, { mode: 0o755 });
  chmodSync(join(directory, name), 0o755);
  writeFileSync(join(directory, ".install-complete.json"), JSON.stringify({ releaseId, version, executable: { name, bytes: Buffer.byteLength(script) }, harness: null }));
  writeFileSync(join(root, "active.json"), JSON.stringify({ releaseId }));
  return join(directory, name);
}

/** Runs the fake's `acp --login` for a profile directory the way a person at a terminal would, and pastes `code`. */
export function loginAt(fixture: NativeFixture, profileDirectory: string, code: string, env: Record<string, string> = {}): Promise<number | null> {
  return new Promise((done) => {
    const child = spawnCli(fixture.executable, ["acp", "--login", "--gemini-dir", profileDirectory, "--app-data-dir", "antigravity-acp"], {
      env: { ...process.env, FAKE_AGY_LOG: fixture.log, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.end(`${code}\n`);
    child.once("close", (exit) => done(exit));
  });
}

/** Whether the CLI accepts a session for the profile directory, asked directly over ACP and by nothing of the app's. */
export function sessionAcceptedAt(fixture: NativeFixture, profileDirectory: string): Promise<boolean> {
  return new Promise((done, fail) => {
    const child = spawnCli(fixture.executable, ["acp", "--gemini-dir", profileDirectory, "--app-data-dir", "antigravity-acp"], {
      env: { ...process.env, FAKE_AGY_LOG: fixture.log },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.resume();
    let buffer = "";
    let answered = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        const message = JSON.parse(line) as { id?: number; error?: unknown };
        if (message.id === 2 && !answered) {
          answered = true;
          child.kill();
          done(message.error === undefined);
        }
      }
    });
    child.once("error", fail);
    child.once("close", (code) => { if (!answered) fail(new Error(`the CLI exited (${code}) before it answered session/new`)); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: profileDirectory, mcpServers: [] } })}\n`);
  });
}

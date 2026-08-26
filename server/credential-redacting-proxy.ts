// Final app-owned boundary for a CredVault-injected stdio MCP backend.
//
// CredVault launches this process with the selected value in the environment.
// The gateway sends backend configuration over the private stdin pipe, never
// argv, then this proxy removes every protected exact value from complete
// newline-delimited records before any backend output reaches the gateway.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";

const BootstrapSchema = z.object({
  schema: z.literal("openmaus.credential-backend-bootstrap.v1"),
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()),
  protectedEnvironmentNames: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)),
});
type Bootstrap = z.infer<typeof BootstrapSchema>;

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const REDACTION = "[REDACTED]";
let child: ChildProcessWithoutNullStreams | null = null;
let settled = false;

function scrub(text: string, values: string[]): string {
  let result = text;
  for (const value of values) result = result.split(value).join(REDACTION);
  return result;
}

function proxyLines(source: Readable, destination: Writable, values: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const flush = (includePartial: boolean): void => {
      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        const record = buffer.subarray(0, newline + 1);
        buffer = buffer.subarray(newline + 1);
        if (record.byteLength > MAX_LINE_BYTES) throw new Error("credential backend record exceeded the safe limit");
        destination.write(scrub(record.toString("utf8"), values));
      }
      if (buffer.byteLength > MAX_LINE_BYTES) throw new Error("credential backend record exceeded the safe limit");
      if (includePartial && buffer.byteLength) {
        destination.write(`${scrub(buffer.toString("utf8"), values)}\n`);
        buffer = Buffer.alloc(0);
      }
    };
    source.on("data", (chunk: Buffer | string) => {
      try {
        buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        flush(false);
      } catch (error) {
        reject(error);
      }
    });
    source.once("end", () => {
      try {
        flush(true);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    source.once("error", reject);
  });
}

function stop(exitCode: number): void {
  if (settled) return;
  settled = true;
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  if (child) process.stdin.unpipe(child.stdin);
  process.stdin.pause();
  // stdout/stderr are pipes and may still have redacted frames queued. Let
  // Node drain them naturally instead of truncating them with process.exit().
  process.exitCode = exitCode;
}

async function start(bootstrap: Bootstrap): Promise<void> {
  const selectedValues = bootstrap.protectedEnvironmentNames
    .map((name) => process.env[name] ?? bootstrap.env[name] ?? "")
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
    .sort((left, right) => right.length - left.length);
  const backendEnv: NodeJS.ProcessEnv = { ...process.env, ...bootstrap.env };
  child = spawn(bootstrap.command, bootstrap.args, {
    cwd: bootstrap.cwd,
    env: backendEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {});
  const stdoutDone = proxyLines(child.stdout, process.stdout, selectedValues);
  const stderrDone = proxyLines(child.stderr, process.stderr, selectedValues);
  void stdoutDone.catch(() => child?.kill("SIGTERM"));
  void stderrDone.catch(() => child?.kill("SIGTERM"));
  process.stdin.pipe(child.stdin);
  const runningChild = child;
  const code = await new Promise<number | null>((resolveClose, reject) => {
    runningChild.once("error", reject);
    runningChild.once("close", resolveClose);
  });
  await Promise.all([stdoutDone, stderrDone]);
  stop(code ?? 1);
}

function readBootstrap(): Promise<Bootstrap> {
  return new Promise((resolveBootstrap, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error("credential backend bootstrap was not received"));
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("credential backend bootstrap failed"));
    };
    const onData = (chunk: Buffer | string): void => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (buffer.byteLength > MAX_LINE_BYTES) {
        cleanup();
        reject(new Error("credential backend bootstrap exceeded the safe limit"));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      process.stdin.pause();
      cleanup();
      const line = buffer.subarray(0, newline).toString("utf8");
      const remainder = buffer.subarray(newline + 1);
      if (remainder.byteLength) process.stdin.unshift(remainder);
      try {
        resolveBootstrap(BootstrapSchema.parse(JSON.parse(line)));
      } catch {
        reject(new Error("credential backend bootstrap is invalid"));
      }
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
  });
}

void readBootstrap().then(start).catch(() => stop(64));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => stop(signal === "SIGINT" ? 130 : 143));
}

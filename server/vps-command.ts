import { DATA_DIR } from "./config.ts";
import { augmentedPath } from "./env-path.ts";
import { killCliTree, spawnCli } from "./procs.ts";
import { ensureVpsSshMaster, prepareVpsSsh } from "./vps-ssh.ts";
import { dockerCliStartMessage } from "./vps-hints.ts";

// ssh + docker need this long to tear down a remote exec over a WAN; an orphaned exec keeps the driver socket busy.
const COMMAND_TIMEOUT_TERM_GRACE_MS = 5_000;
// killCliTree also waits up to one second for the forced group exit.
export const COMMAND_TIMEOUT_KILL_GRACE_MS = COMMAND_TIMEOUT_TERM_GRACE_MS + 1_000;

export interface VpsCommandOptions {
  input?: string;
  timeoutMs?: number;
}

export type VpsCommandRunner = (
  args: string[],
  options?: VpsCommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

const STREAM_CAP_CHARS = 16 * 1024 * 1024;

/** SSH never got through (or the command ran out of time): unlike a Docker refusal, nothing on the host answered. */
export class VpsHostUnreachableError extends Error {}

// OpenSSH's own words when it never reached the host. Exit status 255 alone is not proof: ssh also passes on a remote command's 255.
const SSH_TRANSPORT_FAILURE = /\bssh: (?:Could not resolve hostname|connect to host \S+ port \d+:)/i;

/** Only a lookup or connection failure ssh reports itself, or a timeout, means nothing on the host answered. */
function sshNeverReachedHost(error: unknown): boolean {
  if ((error as { killed?: boolean }).killed === true) return true;
  const message = error instanceof Error ? error.message : String(error);
  return SSH_TRANSPORT_FAILURE.test(message) || message === "VPS SSH initialization timed out";
}

function tailCollector() {
  const chunks: string[] = [];
  let total = 0;
  return {
    push(chunk: string) {
      chunks.push(chunk);
      total += chunk.length;
      for (;;) {
        const first = chunks[0];
        if (chunks.length < 2 || first === undefined || total - first.length < STREAM_CAP_CHARS) break;
        chunks.shift();
        total -= first.length;
      }
    },
    text(): string {
      return chunks.join("").slice(-STREAM_CAP_CHARS);
    },
  };
}

export async function defaultRunner(args: string[], options: VpsCommandOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const ssh = prepareVpsSsh(DATA_DIR, augmentedPath());
  let deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const destination = args[0] === "-H" && args[1]?.startsWith("ssh://") ? args[1].slice(6) : null;
  // Time spent waking a paused host does not count against the command's own timeout.
  if (destination) {
    try { deadline += await ensureVpsSshMaster(ssh, destination, Math.min(30_000, deadline - Date.now())); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw sshNeverReachedHost(error) ? new VpsHostUnreachableError(message) : new Error(message);
    }
  }
  if (Date.now() >= deadline) throw new VpsHostUnreachableError("Docker-over-SSH command timed out");
  return new Promise((resolve, reject) => {
    // Docker's SSH transport runs the first `ssh` on PATH: the app's shim, which shares one connection.
    const child = spawnCli("docker", args, {
      shell: false,
      env: { ...process.env, PATH: ssh.path },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = tailCollector();
    const stderr = tailCollector();
    let settled = false;
    let failure: Error | null = null;
    let timeout: ReturnType<typeof setTimeout>;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      finish();
    };
    const fail = (error: Error) => {
      if (settled || failure) return;
      failure = error;
      clearTimeout(timeout);
      // ssh can hold these pipes after Docker exits; stop only this command's process group (SSH masters detach from it).
      const cleaned = () => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        settle(() => reject(error));
      };
      void killCliTree(child, COMMAND_TIMEOUT_TERM_GRACE_MS).then(cleaned, cleaned);
    };
    timeout = setTimeout(() => fail(new VpsHostUnreachableError("Docker-over-SSH command timed out")), Math.max(1, deadline - Date.now()));
    timeout.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr.push(chunk);
    });
    child.stdin.on("error", (error) => {
      fail(new Error(`Docker-over-SSH stdin failed: ${error.message}`));
    });
    child.on("error", (error: Error) => {
      fail(new Error(dockerCliStartMessage(error)));
    });
    child.on("close", (code, signal) => {
      if (failure) return;
      settle(() => {
        if (code === 0) return resolve({ stdout: stdout.text(), stderr: stderr.text() });
        const captured = stderr.text().trim();
        const message = captured.slice(-1000) || `Docker-over-SSH exited ${code ?? signal ?? "without a status"}`;
        reject(SSH_TRANSPORT_FAILURE.test(captured) ? new VpsHostUnreachableError(message) : new Error(message));
      });
    });
    try {
      child.stdin.end(options.input);
    } catch (error) {
      fail(new Error(`Docker-over-SSH stdin failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
}

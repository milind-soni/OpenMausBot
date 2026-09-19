// Talking to a running server over loopback (the owner's channel) and the OS
// URL opener, plus the shared error-message helper.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizePhoneOrigin } from "../cli-phone-setup.ts";
import type { CliOptions } from "./options.ts";

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ── talking to a running server (loopback = owner) ────────────────────
export async function api(port: number, path: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: init.method, body: init.body, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(3000) });
  const body: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

export async function serverUp(port: number, pid?: number): Promise<boolean> {
  try {
    const { status, body } = await api(port, "/api/health");
    return status === 200 && body?.app === "openmausbot" && (pid === undefined || body.pid === pid);
  } catch {
    return false;
  }
}

/** Check identity before reusing a running process. Never attach to another
 * workspace just because it happens to be listening on the requested port. */
export async function isWorkspaceRunning(options: CliOptions): Promise<boolean> {
  try {
    const { status, body } = await api(options.port, "/api/health");
    if (status !== 200 || body?.app !== "openmausbot") return false;
    const expected = readFileSync(join(options.dataDir, "environment-id"), "utf8").trim();
    const descriptor = await api(options.port, "/.well-known/openmausbot/environment");
    return /^[0-9a-f-]{36}$/i.test(expected) && descriptor.status === 200 && descriptor.body?.environmentId === expected;
  } catch { return false; }
}

/** No shell commands, credentials or remote URLs go to the OS URL opener. */
export async function openDashboard(port: number, env = process.env): Promise<boolean> {
  if (env.SSH_CONNECTION || env.SSH_TTY || (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY)) return false;
  const url = `http://127.0.0.1:${port}`;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { child.kill(); done(false); }, 3000);
    child.once("error", () => { clearTimeout(timer); done(false); });
    child.once("exit", (code) => { clearTimeout(timer); done(code === 0); });
  });
}

/** A valid URL alone is not enough: its public descriptor must identify this
 * exact server. This probe never sends a pairing code or an auth credential. */
export async function verifyPhoneEndpoint(port: number, origin: string): Promise<boolean> {
  if (!normalizePhoneOrigin(origin)) return false;
  try {
    const local = await api(port, "/.well-known/openmausbot/environment");
    const remote = await fetch(`${origin}/.well-known/openmausbot/environment`, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (local.status !== 200 || !remote.ok) return false;
    const descriptor = await remote.json() as { environmentId?: unknown };
    return typeof local.body?.environmentId === "string" && local.body.environmentId.length > 0
      && descriptor.environmentId === local.body.environmentId;
  } catch { return false; }
}

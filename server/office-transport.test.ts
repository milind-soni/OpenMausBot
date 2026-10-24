import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { spawn } from "node:child_process";
import { createOfficeDirectiveRequester, type OfficeTransportConfig } from "./office-transport.ts";

const config: OfficeTransportConfig = { version: 1, workerId: "c7fbfb41-e544-4c72-b741-fa12536a290a", controllerHost: "orch-hel1",
  host: "100.103.173.81", port: 2222, user: "orca", identityFile: "/private/key", knownHostsFile: "/private/known_hosts" };
const request = { version: 1 as const, attemptId: "55db8582-1234-4321-abcd-55db85821234", capability: "a".repeat(43), workerId: config.workerId };
function fake() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  const launch = vi.fn(() => child) as unknown as typeof spawn;
  return { child, launch };
}
describe("office controller SSH transport", () => {
  it("uses one fixed key-bound RPC with a clean environment and validates attempt identity", async () => {
    const { child, launch } = fake();
    const pending = createOfficeDirectiveRequester(config, launch)(request, new AbortController().signal);
    child.stdout.end(JSON.stringify({ ok: true, attemptId: request.attemptId }));
    child.emit("close", 0);
    await pending;
    const [command, args, options] = vi.mocked(launch).mock.calls[0]!;
    expect(command).toBe("/usr/bin/ssh");
    expect(args).toContain("IdentityAgent=none");
    expect(args).toContain("2222");
    expect(args?.at(-1)).toBe("orca@100.103.173.81");
    expect(options?.env).toEqual({ HOME: "/home/orca", USER: "orca", LOGNAME: "orca", LANG: "C.UTF-8", PATH: "/usr/bin:/bin" });
    expect(child.stdin.read()?.toString()).toBe(JSON.stringify(request) + "\n");
  });
  it("rejects a response for a different attempt", async () => {
    const { child, launch } = fake();
    const pending = createOfficeDirectiveRequester(config, launch)(request, new AbortController().signal);
    child.stdout.end(JSON.stringify({ ok: true, attemptId: "another-attempt" }));
    child.emit("close", 0);
    await expect(pending).rejects.toThrow("unavailable or refused");
  });
  it("aborts pending SSH without waiting for a remote response", async () => {
    const { child, launch } = fake();
    const signal = new AbortController();
    const pending = createOfficeDirectiveRequester(config, launch)(request, signal.signal);
    signal.abort();
    await expect(pending).rejects.toThrow("unavailable or refused");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", 255);
  });
  it("starts no process for an already stopped request", async () => {
    const { launch } = fake();
    const signal = new AbortController(); signal.abort();
    await expect(createOfficeDirectiveRequester(config, launch)(request, signal.signal)).rejects.toThrow("stopped");
    expect(launch).not.toHaveBeenCalled();
  });
});

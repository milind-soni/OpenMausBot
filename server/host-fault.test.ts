import { describe, expect, it } from "vitest";
import { hostFaultOf, retryCannotFix } from "./host-fault.ts";

describe("hostFaultOf", () => {
  it.each([
    ["spawn /usr/local/bin/claude EAGAIN", "process_start"],
    ["Error: spawn EMFILE", "process_start"],
    ["posix_spawn failed: ENOMEM", "process_start"],
    ["fork: Resource temporarily unavailable", "process_start"],
    ["EMFILE: too many open files, open '/data/x'", "process_start"],
    ["There is no room to start another program (EAGAIN), so this task could not run. Nothing was sent to the AI.", "process_start"],
    ["Ran out of room, so I stopped this task to keep everything else running.", "out_of_room"],
    ["Ran out of room, so I closed the browser to keep everything else running. (3 tasks)", "out_of_room"],
    ["claude exited null (signal SIGKILL) before result", "out_of_room"],
    ["codex exited 137 before turn/completed", "out_of_room"],
    ["The engine started but never sent its first frame in 60 seconds", "out_of_room"],
    ["ENOSPC: no space left on device, write", "disk_full"],
    ["write failed: Disk quota exceeded", "disk_full"],
    ["MCP server could not start; check its command and installation", "tool_server"],
    ["MCP server exited before the session closed. last words", "tool_server"],
    ['MCP server "crm" is not connected', "tool_server"],
    ['The "crm" MCP server couldn\'t be set up, so Claude couldn\'t start this reply.', "tool_server"],
    ["MCP startup timed out", "tool_server"],
    ["401 Unauthorized", "signed_out"],
    ["Not logged in · Please run /login", "signed_out"],
  ] as const)("%s is %s", (failure, fault) => {
    expect(hostFaultOf(failure)).toBe(fault);
  });

  it("leaves a start held for room to the admission: only that fault may pass on a later start", () => {
    expect(retryCannotFix("out_of_room")).toBe(false);
    expect((["process_start", "disk_full", "tool_server", "signed_out"] as const).every(retryCannotFix)).toBe(true);
  });

  it("reads the engine's own stop reason for a sign-in", () => {
    expect(hostFaultOf("The turn ended", "auth_required")).toBe("signed_out");
  });

  it.each([
    "503 Service Unavailable",
    "429 rate limit exceeded",
    "ECONNRESET",
    "socket hang up",
    "The AI stopped before it answered",
    "read EAGAIN",
    "Tool search_crm failed: record not found",
    "claude exited 1 before result: Error: boom",
  ])("%s is not this server's fault", (failure) => {
    expect(hostFaultOf(failure)).toBeNull();
  });
});

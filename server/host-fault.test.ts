import { describe, expect, it } from "vitest";
import { hostFaultOf } from "./host-fault.ts";

describe("hostFaultOf", () => {
  it.each([
    ["spawn /usr/local/bin/claude EAGAIN", "process_start"],
    ["Error: spawn EMFILE", "process_start"],
    ["posix_spawn failed: ENOMEM", "process_start"],
    ["fork: Resource temporarily unavailable", "process_start"],
    ["EMFILE: too many open files, open '/data/x'", "process_start"],
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
  ])("%s is not this server's fault", (failure) => {
    expect(hostFaultOf(failure)).toBeNull();
  });
});

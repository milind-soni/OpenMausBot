import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { agentGraphVerdict } from "./agent-graph-permissions.ts";

describe("agent graph permission envelope", () => {
  it("never auto-approves provider-native tools or unsandboxed shell execution", () => {
    const context = { cwd: realpathSync(tmpdir()) };
    expect(agentGraphVerdict("read", "filesystem_read", join(context.cwd, "project", "source.ts"), context).approve).toBeNull();
    expect(agentGraphVerdict("read", "edit", "change source.ts", context).approve).toBeNull();
    expect(agentGraphVerdict("workspace-write", "edit", "change source.ts", context).approve).toBeNull();
    expect(agentGraphVerdict("workspace-write", "shell", "pnpm exec vitest run server/example.test.ts", context).approve).toBeNull();
  });

  it("keeps protected, external, credentialed, destructive, and host-control actions behind a card", () => {
    for (const [tool, summary] of [
      ["shell", "git push origin main"],
      ["shell", "curl https://example.com"],
      ["shell", "rm -rf scratch"],
      ["composio", "send Gmail message"],
      ["shell", "gh pr merge 12"],
      ["shell", "security find-generic-password"],
    ]) expect(agentGraphVerdict("workspace-write", tool, summary, { cwd: "/tmp/project" }).approve).toBeNull();
    expect(agentGraphVerdict("protected", "filesystem_read", "/tmp/project/source.ts", { cwd: "/tmp/project" }).approve).toBeNull();
    expect(agentGraphVerdict("read", "filesystem_read", "/tmp/project/source.ts", { cwd: "/tmp/project", scope: "local-computer" }).approve).toBeNull();
  });

  it("inspects full-task capability calls instead of approving the MCP server wholesale", () => {
    const call = (server: string, tool: string, args: Record<string, unknown>) => JSON.stringify({
      serverName: "openmaus_capabilities",
      tool: "call_capability",
      arguments: { server, tool, arguments: args },
    });
    const context = { cwd: realpathSync(tmpdir()) };
    expect(agentGraphVerdict("read", "call_capability", call("openmaus-host", "filesystem_read", { path: "README.md" }), context).approve).toBeTruthy();
    expect(agentGraphVerdict("read", "call_capability", call("openmaus-host", "filesystem_write", { path: "README.md" }), context).approve).toBeNull();
    expect(agentGraphVerdict("workspace-write", "call_capability", call("openmaus-host", "filesystem_write", { path: "README.md" }), context).approve).toBeNull();
    expect(agentGraphVerdict("workspace-write", "call_capability", call("openmaus-host", "filesystem_write", {
      path: "README.md", expectedSha256: `sha256:${"a".repeat(64)}`,
    }), context).approve).toBeTruthy();
    expect(agentGraphVerdict("workspace-write", "call_capability", call("openmaus-host", "filesystem_write", {
      path: ".git/config", expectedSha256: `sha256:${"a".repeat(64)}`,
    }), context).approve).toBeNull();
    expect(agentGraphVerdict("workspace-write", "call_capability", call("openmaus-host", "filesystem_write", {
      path: "README.md", expectedSha256: `sha256:${"a".repeat(64)}`, append: true,
    }), context).approve).toBeNull();
    expect(agentGraphVerdict("workspace-write", "call_capability", call("openmaus-host", "shell_execute", { command: "pnpm test" }), context).approve).toBeNull();
    expect(agentGraphVerdict("workspace-write", "call_capability", call("github", "create_issue", {}), context).approve).toBeNull();
  });

  it("rejects lexical, absolute, environment, and symlink workspace escapes", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-graph-permissions-")));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    symlinkSync("/etc", join(workspace, "escape"));
    symlinkSync(join(root, "missing-outside"), join(workspace, "dangling"));
    const call = (path: string) => JSON.stringify({
      arguments: { server: "openmaus-host", tool: "filesystem_read", arguments: { path } },
    });
    try {
      for (const summary of ["cat /etc/passwd", "cat ../outside", "cat $HOME/.ssh/id", "cat escape/passwd", "cat dangling/new.txt"]) {
        expect(agentGraphVerdict("read", "shell", summary, { cwd: workspace }).approve).toBeNull();
      }
      for (const path of ["/etc/passwd", "../outside", "escape/passwd", "dangling/new.txt"]) {
        expect(agentGraphVerdict("read", "call_capability", call(path), { cwd: workspace }).approve).toBeNull();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a workspace path whose final file is hard-linked outside", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-graph-hard-link-")));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    mkdirSync(workspace);
    writeFileSync(outside, "outside");
    linkSync(outside, join(workspace, "linked.txt"));
    const call = JSON.stringify({
      arguments: {
        server: "openmaus-host",
        tool: "filesystem_read",
        arguments: { path: "linked.txt" },
      },
    });
    try {
      expect(agentGraphVerdict("read", "call_capability", call, { cwd: workspace }).approve).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

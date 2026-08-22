import { linkSync, mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { agentGraphNoFollowFlag, readStableAgentGraphFile } from "./agent-graph-evidence.ts";

const temporary: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "omb-agent-evidence-"));
  temporary.push(root);
  mkdirSync(join(root, "src"));
  return realpathSync(root);
}

afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("stable agent graph evidence reads", () => {
  it("uses native no-follow where available and the checked Windows fallback otherwise", () => {
    expect(agentGraphNoFollowFlag("win32", 0)).toBe(0);
    expect(() => agentGraphNoFollowFlag("linux", 0)).toThrow(/O_NOFOLLOW/);
  });

  it("returns a normalized relative path and exact content hash", async () => {
    const root = workspace();
    writeFileSync(join(root, "src", "result.txt"), "verified result\n");
    const result = await readStableAgentGraphFile(root, "src/../src/result.txt");
    expect(result).toMatchObject({
      relativePath: "src/result.txt",
      sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(result.body.toString("utf8")).toBe("verified result\n");
    expect(result.info.size).toBe(result.body.byteLength);
  });

  it("rejects paths outside the workspace and oversized files", async () => {
    const root = workspace();
    writeFileSync(join(root, "large.txt"), "12345");
    await expect(readStableAgentGraphFile(root, "../outside.txt")).rejects.toThrow(/outside/);
    await expect(readStableAgentGraphFile(root, "large.txt", 4)).rejects.toThrow(/bounded file size/);
  });

  it.runIf(process.platform !== "win32")("rejects parent symlinks and hard-linked final files", async () => {
    const root = workspace();
    const outside = mkdtempSync(join(tmpdir(), "omb-agent-evidence-outside-"));
    temporary.push(outside);
    writeFileSync(join(outside, "secret.txt"), "outside\n");
    symlinkSync(outside, join(root, "linked"));
    await expect(readStableAgentGraphFile(root, "linked/secret.txt")).rejects.toThrow(/symlink/);

    writeFileSync(join(root, "single.txt"), "inside\n");
    linkSync(join(root, "single.txt"), join(root, "alias.txt"));
    await expect(readStableAgentGraphFile(root, "single.txt")).rejects.toThrow(/single-link/);
  });

  it.runIf(process.platform !== "win32")("rejects a parent swapped to an outside symlink after validation", async () => {
    const root = workspace();
    const outside = mkdtempSync(join(tmpdir(), "omb-agent-evidence-race-outside-"));
    temporary.push(outside);
    writeFileSync(join(root, "src", "result.txt"), "inside\n");
    writeFileSync(join(outside, "result.txt"), "outside\n");

    await expect(readStableAgentGraphFile(root, "src/result.txt", undefined, {
      afterPathValidation: () => {
        renameSync(join(root, "src"), join(root, "src-before-swap"));
        symlinkSync(outside, join(root, "src"));
      },
    })).rejects.toThrow(/changed while it was being read/);
  });

  it.runIf(process.platform !== "win32")("canonicalizes an approved ancestor alias without accepting an evidence symlink", async () => {
    const parent = mkdtempSync(join(tmpdir(), "omb-agent-evidence-alias-"));
    temporary.push(parent);
    const target = join(parent, "target");
    const alias = join(parent, "alias");
    mkdirSync(join(target, "workspace"), { recursive: true });
    writeFileSync(join(target, "workspace", "result.txt"), "inside\n");
    symlinkSync(target, alias);

    const result = await readStableAgentGraphFile(join(alias, "workspace"), "result.txt");
    expect(result.body.toString("utf8")).toBe("inside\n");
    expect(result.relativePath).toBe("result.txt");
  });
});

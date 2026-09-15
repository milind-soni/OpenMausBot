// PreToolUse command filters (Phase 0, item 0.2, step 9): a small allowlist
// of known noisy commands is rewritten to a bounded form before the engine
// runs them, so a test run or an install does not pour thousands of lines
// into the context. Never blocks, never rewrites what it does not know, and
// never touches a command that already pipes, redirects or chains.
import { describe, expect, it } from "vitest";

import { filterCommand } from "./filters.ts";

describe("filterCommand", () => {
  it("bounds the output of known test runners", () => {
    expect(filterCommand("pnpm test")).toEqual({ command: "pnpm test 2>&1 | tail -n 200", rule: "test-runner" });
    expect(filterCommand("npm test -- --run")).toEqual({ command: "npm test -- --run 2>&1 | tail -n 200", rule: "test-runner" });
    expect(filterCommand("npx vitest run server/x.test.ts")).toEqual({ command: "npx vitest run server/x.test.ts 2>&1 | tail -n 200", rule: "test-runner" });
    expect(filterCommand("pytest tests/")).toEqual({ command: "pytest tests/ 2>&1 | tail -n 200", rule: "test-runner" });
    expect(filterCommand("cargo test")).toEqual({ command: "cargo test 2>&1 | tail -n 200", rule: "test-runner" });
    expect(filterCommand("go test ./...")).toEqual({ command: "go test ./... 2>&1 | tail -n 200", rule: "test-runner" });
  });

  it("bounds package installs", () => {
    expect(filterCommand("pnpm install")).toEqual({ command: "pnpm install 2>&1 | tail -n 40", rule: "install" });
    expect(filterCommand("npm ci")).toEqual({ command: "npm ci 2>&1 | tail -n 40", rule: "install" });
    expect(filterCommand("pip install -r requirements.txt")).toEqual({ command: "pip install -r requirements.txt 2>&1 | tail -n 40", rule: "install" });
  });

  it("caps an unbounded git log", () => {
    expect(filterCommand("git log")).toEqual({ command: "git log -n 30", rule: "git-log" });
    expect(filterCommand("git log --oneline main")).toEqual({ command: "git log -n 30 --oneline main", rule: "git-log" });
    expect(filterCommand("git log -n 5")).toBeNull();
    expect(filterCommand("git log --max-count=3")).toBeNull();
    expect(filterCommand("git log -3")).toBeNull();
  });

  it("leaves everything else alone: unknown commands, and anything already piped, redirected or chained", () => {
    expect(filterCommand("ls -la")).toBeNull();
    expect(filterCommand("cat big.log")).toBeNull();
    expect(filterCommand("pnpm test | head -n 5")).toBeNull();
    expect(filterCommand("pnpm test > out.txt")).toBeNull();
    expect(filterCommand("pnpm install && pnpm test")).toBeNull();
    expect(filterCommand("pnpm test; echo done")).toBeNull();
    expect(filterCommand("pnpm test\necho done")).toBeNull();
    expect(filterCommand("echo $(pnpm test)")).toBeNull();
    expect(filterCommand("")).toBeNull();
  });
});

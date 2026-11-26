import { describe, expect, it } from "vitest";

import { attachNotFound } from "./attach-file-hint.ts";

describe("attach_file's hint when no file is at the path", () => {
  it("names this turn's own working folder, never the Local VM's on a Mac", () => {
    expect(attachNotFound("/tmp/report.pdf", "/Users/sam/.openmausbot/task-workspaces/bot/thread")).toBe("No file was found at /tmp/report.pdf. Save it under /Users/sam/.openmausbot/task-workspaces/bot/thread (your working folder) and pass its exact path.");
    expect(attachNotFound("C:\\tmp\\a.pdf", "D:\\omb\\task-workspaces\\bot")).toContain("D:\\omb\\task-workspaces\\bot");
    expect(attachNotFound("/x", undefined)).toBe("No file was found at /x. Save it under your working folder and pass its exact path.");
    expect(attachNotFound("/x", "/Users/sam/w")).not.toContain("/home/cua");
  });

  it("the server builds it from the turn's own folders: the VM's workspace only for a turn on the Local VM", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).not.toContain("Save it under /home/cua/workspace");
    expect(source).toMatch(/attachNotFound\(requestedPath, localVmThreadTargets\.has\(threadId\) \? VM_WORKSPACE_GUEST : messageFileRootsForThread\(from\.id, threadId\)\.find\(\(root\) => root !== ATTACHMENTS_DIR\)\)/u);
  });
});

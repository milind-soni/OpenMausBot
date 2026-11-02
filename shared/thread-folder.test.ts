import { describe, expect, it } from "vitest";

import { isOwnThreadFolder } from "./thread-folder.ts";

describe("isOwnThreadFolder", () => {
  it("knows a thread's own folder on every OS, trailing separator or not", () => {
    expect(isOwnThreadFolder("/home/ada/.openmausbot/task-workspaces/bot-1/thread-1", "bot-1", "thread-1")).toBe(true);
    expect(isOwnThreadFolder("/home/ada/.openmausbot/task-workspaces/bot-1/thread-1/", "bot-1", "thread-1")).toBe(true);
    expect(isOwnThreadFolder("C:\\Users\\Ada\\.openmausbot\\task-workspaces\\bot-1\\thread-1", "bot-1", "thread-1")).toBe(true);
  });

  it("is never another thread's folder, another bot's, a folder inside one, a chosen folder or none", () => {
    expect(isOwnThreadFolder("/data/task-workspaces/bot-1/thread-2", "bot-1", "thread-1")).toBe(false);
    expect(isOwnThreadFolder("/data/task-workspaces/bot-2/thread-1", "bot-1", "thread-1")).toBe(false);
    expect(isOwnThreadFolder("/data/task-workspaces/bot-1/thread-1/src", "bot-1", "thread-1")).toBe(false);
    expect(isOwnThreadFolder("/data/workspaces/bot-1/thread-1", "bot-1", "thread-1")).toBe(false);
    expect(isOwnThreadFolder("/Users/ada/Projects/site", "bot-1", "thread-1")).toBe(false);
    expect(isOwnThreadFolder(null, "bot-1", "thread-1")).toBe(false);
    expect(isOwnThreadFolder(undefined, "bot-1", "thread-1")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { applyWorkspaceClientState, collectWorkspaceClientState } from "./workspace-backup-client";
import { SEND_KEY_KEY } from "./send-key";

function memory(values: Record<string, string>) {
  const entries = new Map(Object.entries(values));
  return { entries, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
}

describe("full-backup browser state", () => {
  it("exports exact app drafts/preferences, never saved webhook credentials or auth/cache keys", () => {
    const storage = memory({ "omb-drafts": "draft", "omb-webhook-credentials": "private URL", "omb-skin": "daylight", "auth-token": "secret", "omb-connected-apps": "cached accounts", "omb-email-gate": "identity", "omb-pending-workspace-restore": "old" });
    expect(collectWorkspaceClientState(storage)).toEqual({ "omb-drafts": "draft", "omb-skin": "daylight" });
  });

  it("replaces only allowlisted keys and clears old drafts absent from the backup", () => {
    const storage = memory({ "omb-drafts": "old", "omb-draft-attachments": "old attachment", "auth-token": "keep", "omb-webhook-credentials": "destination URL" });
    applyWorkspaceClientState({ "omb-drafts": "restored", "omb-show-threads": "false" }, storage);
    expect(Object.fromEntries(storage.entries)).toEqual({ "omb-drafts": "restored", "omb-show-threads": "false", "auth-token": "keep", "omb-webhook-credentials": "destination URL" });
  });

  it("carries the run card visibility choice in a workspace backup", () => {
    const storage = memory({ "omb-show-run-card": "0" });
    expect(collectWorkspaceClientState(storage)).toEqual({ "omb-show-run-card": "0" });
    applyWorkspaceClientState({ "omb-show-run-card": "1" }, storage);
    expect(storage.getItem("omb-show-run-card")).toBe("1");
  });

  it("carries the send key choice in a workspace backup", () => {
    const storage = memory({ [SEND_KEY_KEY]: "mod-enter" });
    expect(collectWorkspaceClientState(storage)).toEqual({ "omb-send-key": "mod-enter" });
    applyWorkspaceClientState({ "omb-send-key": "enter" }, storage);
    expect(storage.getItem(SEND_KEY_KEY)).toBe("enter");
  });

  it.each([null, [], { "auth-token": "injected" }, { "omb-webhook-credentials": "source URL" }, { "omb-drafts": 1 }])("rejects invalid client state before clearing anything (%j)", (value) => {
    const storage = memory({ "omb-drafts": "old", "auth-token": "keep" });
    expect(() => applyWorkspaceClientState(value, storage)).toThrow("Invalid backup browser state");
    expect(Object.fromEntries(storage.entries)).toEqual({ "omb-drafts": "old", "auth-token": "keep" });
  });

  it("rolls browser state back if restored values exceed storage quota", () => {
    const storage = memory({ "omb-drafts": "old", "omb-skin": "daylight", "auth-token": "keep" });
    const original = storage.setItem;
    storage.setItem = (key, value) => { if (value === "too large") throw new Error("quota"); original(key, value); };
    expect(() => applyWorkspaceClientState({ "omb-drafts": "too large" }, storage)).toThrow("quota");
    expect(Object.fromEntries(storage.entries)).toEqual({ "omb-drafts": "old", "omb-skin": "daylight", "auth-token": "keep" });
  });
});

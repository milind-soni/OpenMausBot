import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { ClaudeAccountSettings } from "./ClaudeAccountSettings";

const fixture = vi.hoisted(() => ({
  instances: [] as InstanceInfo[], dispatch: vi.fn(), refreshInstances: vi.fn(),
  confirm: null as null | (() => void),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({
    state: { instances: fixture.instances, bots: [] },
    dispatch: fixture.dispatch, refreshInstances: fixture.refreshInstances,
  }),
}));
vi.mock("./ConfirmDialog", () => ({
  ConfirmDialog: ({ title, onConfirm }: { title: string; onConfirm: () => void }) => {
    if (title.startsWith("Sign out")) fixture.confirm = onConfirm;
    return null;
  },
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); fixture.confirm = null; });

it("uses the confirmed Claude sign-out response without depending on another catalog request", async () => {
  const instance: InstanceInfo = {
    instanceId: "claude-work", driverKind: "claudeAgent", displayName: "Work", cliDefault: "claude",
    snapshot: { state: "available", authenticated: true, account: { email: "ada@example.test" } },
    models: { default: "sonnet", options: [] },
    authentication: { method: "paste-code", signOut: true },
    claudeAccount: { configDir: "/fixture/work", signInCommand: "claude auth login", signInShell: "sh", isDefault: false },
  };
  const signedOut = { ...instance, snapshot: { state: "available" as const, authenticated: false } };
  fixture.instances = [instance];
  fixture.refreshInstances.mockRejectedValue(new Error("Catalog unavailable"));
  fixture.dispatch.mockImplementation((action: { type: string; instances: InstanceInfo[] }) => {
    if (action.type === "instances") fixture.instances = action.instances;
  });
  const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ instances: [signedOut] })));
  vi.stubGlobal("fetch", request);
  renderToStaticMarkup(createElement(ClaudeAccountSettings, { instance }));
  fixture.confirm!();
  await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "instances", instances: [signedOut] }));
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith("/api/instances/claude-work/auth/sign-out", expect.objectContaining({ method: "POST" }));
  expect(fixture.refreshInstances).not.toHaveBeenCalled();
  const markup = renderToStaticMarkup(createElement(ClaudeAccountSettings, { instance: fixture.instances[0]! }));
  expect(markup).not.toContain("ada@example.test");
  expect(markup).not.toContain("Sign out of Claude");
  expect(markup).toContain("Sign-in required");
});

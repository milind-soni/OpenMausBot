import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { CodexAccountSettings } from "./CodexAccountSettings";
import { EnginesSettings } from "./EnginesSettings";

const fixture = vi.hoisted(() => ({
  instances: [] as InstanceInfo[],
  dispatch: vi.fn(),
  refreshInstances: vi.fn(),
  confirm: null as null | (() => void),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({
    state: { instances: fixture.instances, bots: [] },
    dispatch: fixture.dispatch,
    refreshInstances: fixture.refreshInstances,
  }),
}));
// Capture the handler without a browser or any live provider credentials.
vi.mock("./ConfirmDialog", () => ({
  ConfirmDialog: ({ onConfirm }: { onConfirm: () => void }) => {
    fixture.confirm = onConfirm;
    return null;
  },
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("uses the successful sign-out snapshot even when a later refresh would fail", async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { userAgent: "Linux" });
  const instance: InstanceInfo = {
    instanceId: "codex", driverKind: "codexAgent", displayName: "Codex", cliDefault: "codex",
    snapshot: { state: "available", authenticated: true, account: { email: "ada@example.test" } },
    models: { default: "model", options: [] },
    authentication: { method: "device-code", signOut: true },
    install: { signInCommand: "codex login" },
  };
  const signedOut = { ...instance, snapshot: { state: "available" as const, authenticated: false } };
  fixture.instances = [instance];
  fixture.refreshInstances.mockRejectedValue(new Error("Catalog refresh unavailable"));
  fixture.dispatch.mockImplementation((action: { type: string; instances: InstanceInfo[] }) => {
    if (action.type === "instances") fixture.instances = action.instances;
  });
  const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ instances: [signedOut] })));
  vi.stubGlobal("fetch", request);

  renderToStaticMarkup(createElement(CodexAccountSettings, { instance }));
  fixture.confirm!();

  await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "instances", instances: [signedOut] }));
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith("/api/instances/codex/auth/sign-out", expect.objectContaining({ method: "POST" }));
  expect(fixture.refreshInstances).not.toHaveBeenCalled();
  const markup = renderToStaticMarkup(createElement(EnginesSettings));
  expect(markup).toContain("Connect ChatGPT");
  expect(markup).not.toContain("ChatGPT connected on this server");
  expect(markup).not.toContain("ada@example.test");
});

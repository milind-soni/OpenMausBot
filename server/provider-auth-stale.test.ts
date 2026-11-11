import { describe, expect, it, vi } from "vitest";

import type { ProviderAuthenticationStart, ProviderAuthenticationStatus } from "./contracts.ts";
import { ProviderAuthSessions } from "./provider-auth-sessions.ts";

function fixture() {
  const waiting: ProviderAuthenticationStart = {
    phase: "waiting", flowId: "original", authorizationUrl: "https://auth.example/device", expiresAt: null,
  };
  const signedIn = vi.fn();
  const sessions = new ProviderAuthSessions({ signedIn });
  const instance = {
    instanceId: "engine", startAuthentication: vi.fn(async () => waiting),
    getAuthentication: vi.fn(async (): Promise<ProviderAuthenticationStatus> => waiting), completeAuthentication: vi.fn(async () => undefined),
    cancelAuthentication: vi.fn(async () => undefined), signOut: vi.fn(async () => undefined),
  };
  return { sessions, instance, waiting, signedIn };
}

describe("obsolete provider sign-in results", () => {
  it("keeps the cancelled status readable by the owner after cancellation finishes", async () => {
    const { sessions, instance, waiting, signedIn } = fixture();
    await sessions.start(instance, "owner");
    await sessions.cancel("engine", "owner", "original");
    instance.getAuthentication.mockResolvedValue({ ...waiting, phase: "cancelled", authorizationUrl: null });
    await expect(sessions.status("engine", "owner", "original")).resolves.toMatchObject({
      phase: "cancelled", authorizationUrl: null,
    });
    expect(signedIn).not.toHaveBeenCalled();
    expect(sessions.active).toBe(false);
    await expect(sessions.status("engine", "another-owner", "original")).rejects.toMatchObject({ status: 404 });
  });

  it.each(["cancel", "signOut"] as const)("does not announce a successful poll after %s", async (action) => {
    const { sessions, instance, waiting, signedIn } = fixture();
    await sessions.start(instance, "owner");
    let finish!: (value: ProviderAuthenticationStart) => void;
    instance.getAuthentication.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const poll = sessions.status("engine", "owner", "original");
    if (action === "cancel") await sessions.cancel("engine", "owner", "original");
    else await sessions.signOut(instance, "owner");
    finish({ ...waiting, phase: "succeeded" });
    await expect(poll).rejects.toMatchObject({ status: 404 });
    expect(signedIn).not.toHaveBeenCalled();
  });

  it("does not let a cancelled poll announce success after a replacement sign-in starts", async () => {
    const { sessions, instance, waiting, signedIn } = fixture();
    await sessions.start(instance, "owner");
    let finish!: (value: ProviderAuthenticationStart) => void;
    instance.getAuthentication.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const poll = sessions.status("engine", "owner", "original");
    await sessions.signOut(instance, "owner");
    instance.startAuthentication.mockResolvedValue({ ...waiting, flowId: "replacement" });
    await sessions.start(instance, "new-owner");
    finish({ ...waiting, phase: "succeeded" });
    await expect(poll).rejects.toMatchObject({ status: 404 });
    expect(signedIn).not.toHaveBeenCalled();
    expect(sessions.active).toBe(true);
    await expect(sessions.cancel("engine", "new-owner", "replacement")).resolves.toBeUndefined();
  });

  it.each(["owner", "instance", "fleet"] as const)("does not announce a callback completion after revoking the %s", async (what) => {
    const { sessions, instance, signedIn } = fixture();
    await sessions.start(instance, "owner");
    let finish!: () => void;
    instance.completeAuthentication.mockImplementation(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined); }));
    const completing = sessions.complete("engine", "owner", "original", "https://localhost/callback?code=x");
    if (what === "owner") sessions.revokeOwner("owner");
    else if (what === "instance") sessions.clearInstance("engine");
    else sessions.clear();
    finish();
    await expect(completing).rejects.toMatchObject({ status: 404 });
    expect(signedIn).not.toHaveBeenCalled();
  });
});

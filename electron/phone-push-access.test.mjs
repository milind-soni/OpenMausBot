import { describe, expect, it } from "vitest";
import { createPhonePushAccessSync, phonePushAccessMessage, PHONE_PUSH_ACCESS_MESSAGE } from "./phone-push-access.mjs";

const credential = `omb_install_${"a".repeat(22)}.${"b".repeat(43)}`;
const controlPlane = "https://accounts.openmausbot.com";

describe("phone push access on the desktop", () => {
  it("hands over only the control plane and a well-formed installation credential", () => {
    expect(phonePushAccessMessage({ companionInstallationCredential: credential, companionAccountToken: "secret" }, controlPlane))
      .toEqual({ type: PHONE_PUSH_ACCESS_MESSAGE, access: { controlPlane, credential } });
    expect(phonePushAccessMessage({ companionInstallationCredential: credential }, "")).toEqual({ type: PHONE_PUSH_ACCESS_MESSAGE, access: null });
    expect(phonePushAccessMessage({ companionInstallationCredential: "omb_install_short" }, controlPlane).access).toBeNull();
    expect(phonePushAccessMessage({ companionInstallationCredential: credential, companionAccountCleanupPending: true }, controlPlane).access).toBeNull();
    expect(phonePushAccessMessage(null, controlPlane).access).toBeNull();
  });

  it("posts on each server start and on each change, never twice the same", () => {
    const posted = [];
    let document = {};
    let proc = { postMessage: (message) => posted.push(message) };
    const sync = createPhonePushAccessSync({ server: () => proc, credentials: () => document, controlPlane: () => controlPlane, log: () => {} });
    expect(sync.serverStarted()).toBe(true);
    expect(sync.sync()).toBe(false);
    document = { companionInstallationCredential: credential };
    expect(sync.sync()).toBe(true);
    expect(sync.serverStarted()).toBe(true);
    expect(posted.map((message) => message.access)).toEqual([null, { controlPlane, credential }, { controlPlane, credential }]);
    proc = null;
    document = {};
    expect(sync.sync()).toBe(false);
  });

  it("tries again later when the server could not take the message", () => {
    const logged = [];
    let fail = true;
    const posted = [];
    const sync = createPhonePushAccessSync({
      server: () => ({ postMessage: (message) => { if (fail) throw new Error("closed"); posted.push(message); } }),
      credentials: () => ({}), controlPlane: () => controlPlane, log: (line) => logged.push(line),
    });
    expect(sync.sync()).toBe(false);
    expect(logged).toHaveLength(1);
    fail = false;
    expect(sync.sync()).toBe(true);
    expect(posted).toHaveLength(1);
  });
});

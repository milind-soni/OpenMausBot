import { expect, it } from "vitest";

import type { InstanceInfo } from "@/state/store";
import { pillWay } from "./SignInPill";

const signedOut = (method: NonNullable<InstanceInfo["authentication"]>["method"]): InstanceInfo => ({
  instanceId: "engine", driverKind: "engine", displayName: "Engine",
  models: { default: "model", options: [] },
  snapshot: { state: "available", authenticated: false, version: "1.0.0" },
  authentication: { method },
} as InstanceInfo);

it("signs in from the pill where the provider's page finishes the sign-in", () => {
  for (const method of ["device-code", "paste-code", "browser-pkce"] as const) expect(pillWay(signedOut(method))).toBe("sign-in");
});

it("opens the dialog for a sign-in that may need its redirect pasted back, which the pill cannot show or follow", () => {
  expect(pillWay(signedOut("callback-url"))).toBe("dialog");
});

it("still installs that engine from the pill before its sign-in", () => {
  const notInstalled = { ...signedOut("callback-url"), snapshot: { state: "unavailable" }, authentication: undefined,
    install: { managed: { label: "Install", downloadBytes: 1 } } } as InstanceInfo;
  expect(pillWay(notInstalled)).toBe("install");
});

it("opens the dialog when there is nothing the pill can do itself", () => {
  expect(pillWay(undefined)).toBe("dialog");
});

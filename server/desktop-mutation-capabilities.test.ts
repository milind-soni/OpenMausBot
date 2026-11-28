import { expect, it } from "vitest";

import { desktopMutationCapabilities } from "./desktop-mutation-capabilities.ts";

it("accepts a complete owner and companion capability pair", () => {
  const token = "a".repeat(43);
  const companionToken = "b".repeat(43);
  const type = "openmausbot:desktop-mutation-token";
  expect(desktopMutationCapabilities({ type, token, companionToken })).toEqual({ token, companionToken });
  expect(desktopMutationCapabilities({ type, token })).toBeNull();
  expect(desktopMutationCapabilities({ type, token, companionToken: "invalid" })).toBeNull();
  expect(desktopMutationCapabilities({ type, companionToken })).toBeNull();
  expect(desktopMutationCapabilities({ type: "other", token, companionToken })).toBeNull();
});

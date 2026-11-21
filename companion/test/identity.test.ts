import { describe, expect, it } from "vitest";

import { COMPANION_DIR_NAME as APP_COMPANION_DIR_NAME, PHONE_DISCOVERY_SERVICE_TYPE } from "../../electron/app-identity.mjs";
import { PHONE_SERVICE_TYPE } from "../src/mdns.ts";
import { COMPANION_DIR_NAME } from "../src/state.ts";

describe("companion identity", () => {
  it("keeps its state folder where the desktop app looks for it", () => {
    expect(COMPANION_DIR_NAME).toBe(APP_COMPANION_DIR_NAME);
  });

  it("advertises the Bonjour service type the phone apps browse for", () => {
    expect(PHONE_SERVICE_TYPE).toBe(PHONE_DISCOVERY_SERVICE_TYPE);
  });
});

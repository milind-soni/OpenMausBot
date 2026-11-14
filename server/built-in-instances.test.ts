import { describe, expect, it } from "vitest";

import { BUILT_IN_INSTANCE_DRIVERS } from "../src/lib/built-in-instances.ts";
import { instanceConfigs } from "./config.ts";

describe("the built-in instances the app's analytics names without the instance list", () => {
  it("are this server's default fleet, plus the Gemini instance an enterprise licence restores", () => {
    const fleet = Object.fromEntries(Object.entries(instanceConfigs({})).map(([id, entry]) => [id, entry.driver]));
    expect(BUILT_IN_INSTANCE_DRIVERS).toEqual({ ...fleet, gemini: "geminiAgent" });
  });
});

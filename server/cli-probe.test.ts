import { expect, it } from "vitest";

import { testCliBinary } from "./cli-probe.ts";
import { OpenCodeDriver } from "./drivers/acp/opencode-go.ts";

it("offers the install steps for a CLI that is missing, without the server-only download pins", async () => {
  const result = await testCliBinary("omb-missing-cli-for-this-test", OpenCodeDriver);
  expect(result.ok).toBe(false);
  expect(result.install?.command).toEqual(OpenCodeDriver.install?.command);
  expect(OpenCodeDriver.install?.standalone).toBeDefined();
  expect(result.install).not.toHaveProperty("standalone");
});

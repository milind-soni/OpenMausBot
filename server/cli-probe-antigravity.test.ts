import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { testCliBinary } from "./cli-probe.ts";
import { DATA_DIR } from "./config.ts";
import { AntigravityDriver } from "./drivers/antigravity.ts";
import { antigravityRuntimesRoot } from "./engine-roots.ts";
import { installFakeManagedCli } from "./testing/antigravity-native-fixture.ts";

afterEach(() => rmSync(join(antigravityRuntimesRoot(DATA_DIR), `${process.platform}-${process.arch}`), { recursive: true, force: true }));

it("accepts the path antigravity for an Antigravity account before the app installs the CLI, and reports its version after", async () => {
  await expect(testCliBinary("antigravity", AntigravityDriver)).resolves.toEqual({ ok: true });
  installFakeManagedCli(DATA_DIR);
  await expect(testCliBinary("antigravity", AntigravityDriver)).resolves.toEqual({ ok: true, version: "1.5.14" });
});

it("accepts the path that asks for the pinned runtime for an Antigravity account before the app installs it", async () => {
  await expect(testCliBinary("agy_acp_server", AntigravityDriver)).resolves.toEqual({ ok: true });
});

import { expect, it, vi } from "vitest";

import { testCliBinary } from "./cli-probe.ts";
import { OpenCodeDriver } from "./drivers/acp/opencode-go.ts";

const FULL_PROCESS_TABLE_CLI = "omb-eagain-cli-for-this-test";

vi.mock("./procs.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./procs.ts")>();
  const execCli: typeof actual.execCli = (cli, args, opts, cb) => {
    if (cli !== FULL_PROCESS_TABLE_CLI) return actual.execCli(cli, args, opts, cb);
    cb(Object.assign(new Error(`spawn ${cli} EAGAIN`), { code: "EAGAIN" }), "");
  };
  return { ...actual, execCli };
});

it("offers the install steps for a CLI that is missing, without the server-only download pins", async () => {
  const result = await testCliBinary("omb-missing-cli-for-this-test", OpenCodeDriver);
  expect(result.ok).toBe(false);
  expect(result.install?.command).toEqual(OpenCodeDriver.install?.command);
  expect(OpenCodeDriver.install?.standalone).toBeDefined();
  expect(result.install).not.toHaveProperty("standalone");
});

it("offers no install for a CLI that could not start because the machine is out of processes", async () => {
  const result = await testCliBinary(FULL_PROCESS_TABLE_CLI, OpenCodeDriver);
  expect(result.ok).toBe(false);
  expect(result.message).toContain("There is no room to start another program (EAGAIN)");
  expect(result).not.toHaveProperty("install");
});

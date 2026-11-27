import { expect, it, vi } from "vitest";

import { testCliBinary } from "./cli-probe.ts";
import { MistralVibeAgentDriver } from "./drivers/acp/mistral-vibe.ts";
import { OpenCodeDriver } from "./drivers/acp/opencode-go.ts";

const FULL_PROCESS_TABLE_CLI = "omb-eagain-cli-for-this-test";

const PROBED_VERSIONS: Record<string, string> = {
  "omb-vibe-acp-exe": "vibe-acp.EXE 3.1.2\n",
  "omb-vibe-acp-upper": "VIBE-ACP.EXE 3.1.2\n",
  "omb-vibe-acp-other": "other-cli 1.0\n",
};

vi.mock("./procs.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./procs.ts")>();
  const execCli: typeof actual.execCli = (cli, args, opts, cb) => {
    const version = PROBED_VERSIONS[cli];
    if (version !== undefined) return cb(null, version);
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

it.each([
  ["omb-vibe-acp-exe", "vibe-acp.EXE 3.1.2"],
  ["omb-vibe-acp-upper", "VIBE-ACP.EXE 3.1.2"],
])("accepts %s answering --version as %s (Windows keeps the file name's extension and case)", async (cli, version) => {
  expect(await testCliBinary(cli, MistralVibeAgentDriver)).toEqual({ ok: true, version });
});

it("still rejects another program answering --version through vibe-acp's path", async () => {
  const result = await testCliBinary("omb-vibe-acp-other", MistralVibeAgentDriver);
  expect(result.ok).toBe(false);
  expect(result.message).toBe("`omb-vibe-acp-other` is not Mistral (Vibe)'s CLI: it answered --version as another program.");
});

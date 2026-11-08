// @vitest-environment node
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { cloudAccountUsage, createCloudMachine, deleteCloudMachine, executeCloudCommand, findCloudMachine, getCloudMachine, startCloudMachine, stopCloudMachine, type CloudMachine, type CloudProviderName } from "./execution-cloud";
import { shellQuote, sleep } from "./execution-cloud/shared";

// Explicitly gated: the normal test suite never provisions or uses account keys.
// This creates ONE smallest-size paid machine and permanently deletes only that
// returned machine. Do not run against an existing authenticated personal host.
const enabled = process.env.ORIGIN_CLOUD_LIVE_PROVISION === "create-one-disposable-machine";
test.skipIf(!enabled)("live cloud lifecycle: isolated create, env, cold stop/resume persistence, confirmed delete", async () => {
  const provider = process.env.ORIGIN_CLOUD_LIVE_PROVIDER;
  if (provider !== "boxd" && provider !== "boat") throw new Error("Set ORIGIN_CLOUD_LIVE_PROVIDER to boxd or boat");
  const apiKey = process.env.ORIGIN_CLOUD_LIVE_API_KEY;
  if (!apiKey) throw new Error("Set ORIGIN_CLOUD_LIVE_API_KEY privately before this explicitly paid test");
  const key = randomUUID();
  const input = { provider: provider as CloudProviderName, apiKey, idempotencyKey: key, name: `Origin smoke ${key}` };
  let machine: CloudMachine | undefined;
  const ready = async (id: string) => {
    const until = Date.now() + 120000;
    do {
      const current = await getCloudMachine({ ...input, id });
      if (current.state === "running") return;
      await sleep(1500);
    } while (Date.now() < until);
    throw new Error(`Disposable ${provider} machine ${id} never became running`);
  };
  // Persist this nonsecret intent in test output before a possibly lost create.
  console.info("Origin disposable cloud smoke intent", { provider, idempotencyKey: key, name: input.name });
  expect(["available", "unknown"]).toContain((await cloudAccountUsage(input)).status);
  expect(await findCloudMachine(input)).toBeNull();
  try {
    machine = await createCloudMachine(input);
    console.info("Origin disposable cloud smoke machine", { provider, id: machine.id });
    expect((await createCloudMachine(input)).id).toBe(machine.id);
    expect((await findCloudMachine(input))?.id).toBe(machine.id);
    await ready(machine.id);
    const marker = `.origin-smoke-${key}`;
    const script = `import os,pathlib; assert os.environ['ORIGIN_SMOKE_VALUE']==os.environ['ORIGIN_SMOKE_EXPECTED']; (pathlib.Path.home()/${JSON.stringify(marker)}).write_text('persisted'); print('origin-cloud-ok')`;
    const value = "literal'\n$(not-a-command)λ";
    const executed = await executeCloudCommand({ ...input, id: machine.id, command: `python3 -c ${shellQuote(script)}`, env: { ORIGIN_SMOKE_VALUE: value, ORIGIN_SMOKE_EXPECTED: value }, timeoutSeconds: 30 });
    expect(executed).toEqual({ exitCode: 0, stdout: "origin-cloud-ok\n", stderr: "" });
    await stopCloudMachine({ ...input, id: machine.id });
    expect((await getCloudMachine({ ...input, id: machine.id })).state).toBe("stopped");
    await startCloudMachine({ ...input, id: machine.id });
    await ready(machine.id);
    const check = `import pathlib; p=pathlib.Path.home()/${JSON.stringify(marker)}; assert p.read_text()=='persisted'; p.unlink(); print('origin-resume-ok')`;
    expect((await executeCloudCommand({ ...input, id: machine.id, command: `python3 -c ${shellQuote(check)}`, timeoutSeconds: 30 })).stdout).toBe("origin-resume-ok\n");
  } finally {
    // An ambiguous create does NOT set machine. Never delete by guessed name or
    // retry it: use findCloudMachine with the printed intent, then reconcile.
    if (machine) await deleteCloudMachine({ ...input, id: machine.id });
  }
}, 600000);

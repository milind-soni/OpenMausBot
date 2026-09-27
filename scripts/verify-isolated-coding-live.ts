// Explicit opt-in acceptance against disposable provider computers and a new
// local credit database. Never imports the user's app configuration or data.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

assert.equal(process.env.NATION_CODING_ACCEPTANCE, "1", "Explicit live acceptance opt-in required");
const providerName = process.env.NATION_ACCEPTANCE_PROVIDER ?? "daytona";
assert(providerName === "daytona" || providerName === "orgo");
for (const key of ["OPENROUTER_API_KEY", "NATION_CODING_MODEL", "NATION_CODING_PUBLIC_ORIGIN", ...(providerName === "daytona" ? ["DAYTONA_API_KEY", "NATION_ACCEPTANCE_SNAPSHOT"] : ["ORGO_API_KEY", "ORGO_WORKSPACE_ID"])]) assert(process.env[key], `${key} required`);
assert(new URL(process.env.NATION_CODING_PUBLIC_ORIGIN!).protocol === "https:");
const root = process.env.NATION_ACCEPTANCE_ROOT || mkdtempSync(join(tmpdir(), "nation-live-coding-"));
assert.equal(dirname(realpathSync(root)), realpathSync(tmpdir()));
assert.match(basename(root), /^nation-live-coding-[A-Za-z0-9]+$/);
const evidence: unknown[] = [];
if (process.env.NATION_ACCEPTANCE_ROOT) {
  const previous = JSON.parse(readFileSync(join(root, "evidence.json"), "utf8"));
  assert(previous.some((row: { phase?: string; root?: string }) => row.phase === "start" && row.root === root));
  assert(!previous.some((row: { phase?: string; state?: string }) => row.phase === "model-task" && row.state === "completed"), "Use a fresh fixture after any completed model task");
  evidence.push(...previous);
}
process.env.HOME = root;
process.env.OMB_DATA_DIR = root;
process.env.NATION_DATA_DIR = root;
process.env.NATION_CREDITS_DB = join(root, "credits.db");
process.env.NATION_CODING_ENABLED = "1";
delete process.env.NATION_TEST_CODING;
delete process.env.NATION_MEMBER_HOST_ENGINES;
delete process.env.NATION_PRODUCT_OWNER;
delete process.env.NATION_PRODUCT_ADMIN;
const { IsolatedCoding } = await import("../server/isolated-coding.ts");
const { HostedComputerManager } = await import("../server/hosted-computers/manager.ts");
const { createComputerProvider } = await import("../server/hosted-computers/providers.ts");
const { nationLedger } = await import("../server/nation-credit-context.ts");
type Owner = import("../server/isolated-coding.ts").CodingOwner;
type Machine = import("../server/hosted-computers/providers.ts").Machine;
const config = { daytona: { enabled: true, apiKey: process.env.DAYTONA_API_KEY!, snapshot: process.env.NATION_ACCEPTANCE_SNAPSHOT!, user: "root" as const },
  orgo: { enabled: true, apiKey: process.env.ORGO_API_KEY!, workspaceId: process.env.ORGO_WORKSPACE_ID! } };
const provider = await createComputerProvider(providerName, config);
const machines: Machine[] = [];
const capabilities = new Map<string, { token: string; url: string }>();
const remember = (m: Machine) => { if (!machines.some(existing => existing.id === m.id)) machines.push(m); return m; };
const monitored = { ...provider,
  find: async (name: string) => { const m = await provider.find(name); return m ? remember(m) : null; },
  get: async (id: string, name: string) => remember(await provider.get(id, name)),
  create: async (name: string) => {
    const m = await provider.create(name); machines.push(m);
    return m;
  },
  code: async (m: Machine, command: string) => {
    const input = JSON.parse(Buffer.from(command.match(/'([A-Za-z0-9+/=]+)'$/)![1], "base64").toString());
    capabilities.set(input.id, { token: input.token, url: input.url });
    return provider.code!(m, command);
  },
};
const managerRoot = join(root, "computers");
const manager = new HostedComputerManager(managerRoot, root, () => config, async () => monitored);
let coding = new IsolatedCoding({ manager, scope: "operator" });
const server = createServer((req, res) => {
  void coding.handle(req, res, new URL(req.url!, "http://fixture").pathname).then(handled => {
    if (!handled) { res.writeHead(404); res.end(); }
  }).catch(() => { res.writeHead(500); res.end(); });
});
await new Promise<void>(resolve => server.listen(Number(process.env.NATION_ACCEPTANCE_PORT ?? 18879), "127.0.0.1", resolve));
const ledger = nationLedger();
const owner = (id: string): Owner => ({ provider: providerName, key: id, threadId: id, generation: "one", account: { id, verified: true }, current: () => true });
const alice = owner("acceptance-alice"), bob = owner("acceptance-bob");
ledger.grant(alice.account, "acceptance-alice", "acceptance-alice");
ledger.grant(bob.account, "acceptance-bob", "acceptance-bob");
const note = (value: unknown) => { evidence.push(value); console.log(JSON.stringify(value)); writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2)); };
const waitFor = async (check: () => Promise<boolean> | boolean, timeout = 120_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 1000)); }
  throw new Error("Acceptance condition timed out");
};
const lease = async (id: string) => {
  const cap = capabilities.get(id)!;
  return (await fetch(cap.url + "/lease", { headers: { authorization: `Bearer ${cap.token}` }, signal: AbortSignal.timeout(10_000) })).status;
};
const run = async (who: Owner, prompt: string) => {
  const task = coding.start(who, "acceptance", prompt);
  await waitFor(() => coding.status(who, task.taskId).state !== "running", 180_000);
  const result = coding.status(who, task.taskId);
  note({ phase: "model-task", account: who.key, ...result });
  assert.equal(result.state, "completed");
  assert.equal(await lease(task.taskId), 403);
  return task;
};
try {
  note({ phase: "start", root, provider: providerName, model: process.env.NATION_CODING_MODEL, snapshot: config.daytona.snapshot });
  await manager.start(providerName, alice.key, true);
  await manager.start(providerName, bob.key, true);
  assert.notEqual(machines[0].id, machines[1].id);
  note({ phase: "machines", machines });
  const preflight = Buffer.from(readFileSync(new URL("../deploy/verify-isolated-coding.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n")).toString("base64");
  const gatewayUrl = `${new URL(process.env.NATION_CODING_PUBLIC_ORIGIN!).origin}/api/coding-model/operator/${"0".repeat(32)}/lease`;
  const networkCheck = Buffer.from(`import urllib.request, urllib.error
try:
    urllib.request.urlopen(${JSON.stringify(gatewayUrl)}, timeout=10)
    raise AssertionError('Unauthenticated gateway request was accepted')
except urllib.error.HTTPError as error:
    assert error.code == 403, error.code
print('PASS: guest reaches HTTPS gateway; unauthenticated request denied')
`).toString("base64");
  for (const machine of machines) {
    await provider.prepareCoding?.(machine);
    const sandbox = await provider.execute(machine, `printf '%s' '${preflight}' | base64 -d | sh`);
    note({ phase: "sandbox-preflight", machine: machine.id, ...sandbox });
    assert.equal(sandbox.exitCode, 0, "Prepared snapshot must support workspace-write confinement");
    const gateway = await provider.execute(machine, `printf '%s' '${networkCheck}' | base64 -d | python3`);
    note({ phase: "gateway-preflight", machine: machine.id, ...gateway });
    assert.equal(gateway.exitCode, 0, "Guest must reach the gateway before paid acceptance; check provider network policy");
  }
  const a0 = ledger.balance(alice.account.id), b0 = ledger.balance(bob.account.id);
  await run(alice, "Create add.py with add(a,b), and test_add.py using unittest to assert add(2,3)==5. Write owner.txt containing ALICE_ACCEPTANCE. Run python3 -m unittest -v. Report the actual test result. Do not stop until files exist and tests pass.");
  const a1 = ledger.balance(alice.account.id);
  assert(a1 < a0); assert.equal(ledger.balance(bob.account.id), b0);
  const checkA = await manager.execute(providerName, alice.key, "cd ~/.nation-coding/acceptance && cat owner.txt && python3 -m unittest -v");
  assert.equal(checkA.exitCode, 0); assert.match(checkA.stdout, /ALICE_ACCEPTANCE/); assert.match(checkA.stdout, /OK/);
  note({ phase: "alice-files-and-tests", result: checkA });
  await run(bob, "Check whether owner.txt or add.py exists in this project. Neither should exist. Create owner.txt containing BOB_ACCEPTANCE and test_owner.py using unittest asserting that exact file content. Run python3 -m unittest -v and report actual results.");
  assert.equal(ledger.balance(alice.account.id), a1); assert(ledger.balance(bob.account.id) < b0);
  const checkB = await manager.execute(providerName, bob.key, "cd ~/.nation-coding/acceptance && test ! -e add.py && cat owner.txt && python3 -m unittest -v");
  assert.equal(checkB.exitCode, 0); assert.match(checkB.stdout, /BOB_ACCEPTANCE/); assert.doesNotMatch(checkB.stdout, /ALICE_ACCEPTANCE/);
  note({ phase: "bob-files-and-tests", result: checkB });
  await run(alice, "Read the existing owner.txt and add.py. Keep both files. Add a unittest asserting add(-2,2)==0 to test_add.py, then run python3 -m unittest -v.");
  const probe = "cd ~/.nation-coding/acceptance && cat owner.txt && python3 -m unittest -v";
  const persistent = await manager.execute(providerName, alice.key, probe);
  assert.equal(persistent.exitCode, 0); assert.match(persistent.stdout, /ALICE_ACCEPTANCE/);
  note({ phase: "later-task-persistence", result: persistent });
  for (const mode of ["cancel", "restart"] as const) {
    const service = coding;
    const task = service.start(alice, "acceptance", "Run exactly this long-running foreground shell command for a cancellation test: sh -c 'echo $$ > wait.pid; exec sleep 120'. Do not background it. Do not alter other files.");
    await waitFor(async () => {
      // Bubblewrap has its own PID namespace; do not interpret the inner $$
      // as a guest PID. These computers belong exclusively to this fixture.
      const r = await provider.execute(machines[0], "test -f ~/.nation-coding/acceptance/wait.pid && pgrep -f '(^|/)sleep 120$'");
      return r.exitCode === 0;
    }, 90_000);
    if (mode === "cancel") service.revoke(alice.threadId);
    else coding = new IsolatedCoding({ manager: new HostedComputerManager(managerRoot, root, () => config, async () => monitored), scope: "operator" });
    assert.equal(await lease(task.taskId), 403);
    await waitFor(async () => (await provider.execute(machines[0], "test -f ~/.nation-coding/acceptance/wait.pid && ! pgrep -f '(^|/)sleep 120$'")).exitCode === 0, 20_000);
    const files = await provider.execute(machines[0], probe);
    assert.equal(files.exitCode, 0); assert.match(files.stdout, /ALICE_ACCEPTANCE/);
    await provider.execute(machines[0], "rm -f ~/.nation-coding/acceptance/wait.pid");
    note({ phase: mode, capabilityStatus: 403, processStopped: true, filesPersist: true });
  }
  note({ phase: "billing", accounts: [alice, bob].map(who => ({ id: who.account.id, balanceMicros: ledger.balance(who.account.id) })), calls: ledger.db.prepare("SELECT user_id,state FROM credit_calls").all() });
  assert.equal(ledger.db.prepare("SELECT COUNT(*) AS count FROM credit_calls WHERE state IN ('active','pending')").get()!.count, 0);
  note({ phase: "PASS" });
} finally {
  coding.revoke(alice.threadId); coding.revoke(bob.threadId);
  for (const m of machines) await provider.stop(m).catch(() => {});
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  ledger.close();
}

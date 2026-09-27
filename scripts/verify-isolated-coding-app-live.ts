// Paid, explicit opt-in acceptance. Reuses ONLY computers from a passing
// disposable provider acceptance and starts the real app with a fresh home.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { verificationServerEnvironment } from "./control-omb.ts";
import { orgoProvider } from "../server/hosted-computers/providers.ts";

assert.equal(process.env.NATION_CODING_ACCEPTANCE, "1");
for (const key of ["ORGO_API_KEY", "ORGO_WORKSPACE_ID", "OPENROUTER_API_KEY", "NATION_ACCEPTANCE_ROOT", "NATION_CODING_PUBLIC_ORIGIN"]) assert(process.env[key], `${key} required`);
const priorRoot = realpathSync(process.env.NATION_ACCEPTANCE_ROOT!);
assert.equal(dirname(priorRoot), realpathSync(tmpdir()));
assert.match(basename(priorRoot), /^nation-live-coding-[A-Za-z0-9]+$/);
const prior = JSON.parse(readFileSync(join(priorRoot, "evidence.json"), "utf8"));
assert(prior.some((row: any) => row.phase === "PASS"));
assert(prior.some((row: any) => row.phase === "start" && row.provider === "orgo"));
const machines: Array<{ id: string; name: string; state: string }> = prior.findLast((row: any) => row.phase === "machines").machines;
assert.equal(machines.length, 2); assert.notEqual(machines[0].id, machines[1].id);
const origin = new URL(process.env.NATION_CODING_PUBLIC_ORIGIN!);
assert.equal(origin.protocol, "https:"); assert.equal(origin.pathname, "/");
const root = mkdtempSync(join(tmpdir(), "nation-app-coding-"));
mkdirSync(join(root, "tmp"));
const port = Number(process.env.NATION_ACCEPTANCE_PORT ?? 18879);
const base = `http://127.0.0.1:${port}`;
const config = { defaultProvider: "orgo", orgo: { enabled: true, apiKey: process.env.ORGO_API_KEY!, workspaceId: process.env.ORGO_WORKSPACE_ID! } };
const provider = orgoProvider(config.orgo);
const env = { ...verificationServerEnvironment({}, root, port),
  NATION_DATA_DIR: root, NATION_CREDITS_DB: join(root, "credits.db"), NATION_ACCOUNTS: "1", NATION_MAIL_OUTBOX: "1",
  OMB_SIGNIN_EMAILS: "founder@example.test", NATION_PRODUCT_OWNER: "1", OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY!,
  NATION_OPENROUTER_MODEL: "openai/gpt-5.4-mini", NATION_MODEL_FAST: "openai/gpt-5.4-mini", NATION_MODEL_STANDARD: "openai/gpt-5.4-mini", NATION_MODEL_STRONG: "openai/gpt-5.4-mini",
  NATION_CODING_ENABLED: "1", NATION_CODING_MODEL: "openai/gpt-5.4-mini", NATION_CODING_PUBLIC_ORIGIN: origin.origin,
  NATION_HOSTED_COMPUTERS_CONFIG: JSON.stringify(config) };
writeFileSync(join(root, "config.json"), "{}");
const log = openSync(join(root, "server.log"), "a", 0o600);
const child = spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], { env, stdio: ["ignore", log, log] });
closeSync(log);
const evidence: unknown[] = [];
const note = (value: unknown) => { evidence.push(value); console.log(JSON.stringify(value)); writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2)); };
const waitFor = async (check: () => Promise<boolean>, timeout = 360_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 1500)); }
  throw new Error("App acceptance timed out; inspect isolated evidence and server.log");
};
function browser() {
  const cookies = new Map<string, string>();
  return { async request(path: string, method = "GET", body?: unknown) {
    const r = await fetch(base + path, { method, headers: { origin: base, cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join("; "), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(340_000) });
    for (const cookie of r.headers.getSetCookie()) { const pair = cookie.split(";")[0]; const at = pair.indexOf("="); cookies.set(pair.slice(0,at), pair.slice(at+1)); }
    const text = await r.text(); return { status: r.status, body: text ? JSON.parse(text) : {} };
  } };
}
type Browser = ReturnType<typeof browser>;
const records = () => readdirSync(join(root, "workspaces"), { recursive: true }).filter(p => typeof p === "string" && p.includes("hosted-computers/") && p.endsWith(".json")) as string[];
try {
  note({ phase: "start", root, provider: "orgo", publicOrigin: origin.origin });
  await waitFor(async () => { try { return (await fetch(base + "/api/health")).ok; } catch { return false; } }, 60_000);
  const people: Array<{ who: Browser; bot: any; marker: string }> = [];
  for (const [index, label] of ["alice", "bob"].entries()) {
    const who = browser(), email = `${label}@example.test`;
    assert.equal((await who.request("/api/auth/magic/start", "POST", { email })).status, 200);
    const outbox = join(root, "mail-outbox");
    const mail = readdirSync(outbox).map(file => JSON.parse(readFileSync(join(outbox,file),"utf8"))).find(m => m.to === email);
    assert(mail);
    const signed = await who.request("/api/auth/magic/verify", "POST", { token: decodeURIComponent(mail.link.split("#login=")[1]), label: "Live isolated acceptance" });
    assert.equal(signed.status, 200);
    const created = await who.request("/api/bots", "POST", { name: `Acceptance ${label}` });
    assert.equal(created.status, 201);
    const bot = created.body.bot;
    assert.equal(bot.cloudBackend, "orgo");
    assert.equal((await who.request(`/api/bots/${bot.id}`, "PATCH", { computer: "cloud" })).status, 200);
    const before = new Set(records());
    // The two approved slots are already occupied by the passing fixtures.
    // An attempted provision records the account's deterministic request name.
    const provision = await who.request(`/api/bots/${bot.id}/computer/provision`, "POST", {});
    assert(provision.status >= 400, "Expected occupied fixture capacity; refuse unexpected new computers");
    const fresh = records().filter(p => !before.has(p)); assert.equal(fresh.length, 1);
    const record = JSON.parse(readFileSync(join(root, "workspaces", fresh[0]), "utf8")); assert(!record.id);
    const machine = machines[index];
    await provider.get(machine.id, machine.name); // Verify the known fixture identity before reassignment.
    const renamed = await fetch(`https://www.orgo.ai/api/computers/${machine.id}`, { method: "PATCH", headers: { authorization: `Bearer ${config.orgo.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ name: record.name }), signal: AbortSignal.timeout(30_000) });
    assert.equal(renamed.status, 200); machine.name = record.name;
    note({ phase: "fixture-reassigned", machineId: machine.id, name: machine.name });
    assert.equal((await who.request(`/api/bots/${bot.id}/computer/provision`, "POST", {})).status, 200);
    const marker = `${label.toUpperCase()}_APP_ACCEPTANCE`;
    people.push({ who, bot, marker });
    note({ phase: "signed-in-and-provisioned", account: label, machineId: machine.id });
  }
  const balances = async () => Promise.all(people.map(async p => (await p.who.request("/api/credits/status")).body.balanceUsd));
  for (const [index, person] of people.entries()) {
    const before = await balances();
    const messageCount = ((await person.who.request(`/api/threads/${person.bot.threadId}/messages`)).body.messages ?? []).length;
    const text = `Use computer_code_start with project app-acceptance and then computer_code_status until it completes. Ask the coding worker to first verify owner.txt does not exist, then create owner.txt containing exactly ${person.marker} and test_owner.py with a unittest that reads and checks that exact content. Run python3 -m unittest -v. Do not use computer_execute to create these files. Report the actual coding task result.`;
    assert((await person.who.request(`/api/bots/${person.bot.id}/messages`, "POST", { text })).status < 300);
    await waitFor(async () => {
      const messages = (await person.who.request(`/api/threads/${person.bot.threadId}/messages`)).body.messages ?? [];
      writeFileSync(join(root, `messages-${index}.json`), JSON.stringify(messages,null,2));
      const card = messages.find((m: any) => m.card?.requestId && !m.card.answered)?.card;
      if (card) await person.who.request(`/api/bots/${person.bot.id}/respond`, "POST", { threadId: person.bot.threadId, requestId: card.requestId, behavior: "allow" });
      const bots = (await person.who.request("/api/bots")).body.bots ?? [];
      return messages.slice(messageCount).some((m: any) => m.role === "bot" && m.text) && !bots.find((b: any) => b.id === person.bot.id)?.busy;
    });
    const messages = (await person.who.request(`/api/threads/${person.bot.threadId}/messages`)).body.messages;
    writeFileSync(join(root, `messages-${index}.json`), JSON.stringify(messages,null,2));
    const files = await provider.execute(machines[index], "cd ~/.nation-coding/app-acceptance && cat owner.txt && python3 -m unittest -v && test -n \"$(find .runs -name events.jsonl -print -quit)\"");
    note({ phase: "real-app-files-tests", account: index, ...files });
    assert.equal(files.exitCode, 0); assert.match(files.stdout, new RegExp(person.marker)); assert.match(files.stdout,/OK/);
    const after = await balances(); assert(after[index] < before[index]); assert.equal(after[1-index],before[1-index]);
    assert((await people[1-index].who.request(`/api/bots/${person.bot.id}/computer`)).status >= 400);
    note({ phase: "billing-and-access", account: index, before, after, otherAccountDenied: true });
  }
  note({ phase: "PASS", accounts: people.map(p => createHash("sha256").update(p.marker).digest("hex").slice(0,8)), machines });
} catch (error) {
  note({ phase: "FAIL", error: error instanceof Error ? error.message : "Unknown acceptance failure", machines });
  throw error;
} finally {
  child.kill("SIGTERM");
  await new Promise<void>(resolve => { const timer=setTimeout(() => { child.kill("SIGKILL"); resolve(); },15_000); child.once("exit",()=>{clearTimeout(timer);resolve();}); });
  for (const machine of machines) {
    try { await provider.stop(await provider.get(machine.id,machine.name)); } catch { note({ phase: "cleanup-stop-failed", machineId: machine.id }); }
  }
}

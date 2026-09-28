// Real renderer and API against an explicit control-omb UI fixture handle.
// The only substituted responses exercise unavailable-provider and retry UI.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runControlOmb } from "./control-omb.ts";

const handle = process.argv[2];
if (!handle) throw new Error("Usage: node --experimental-strip-types scripts/verify-command-allowlist-ui.ts /path/to/fixture/ui.json");
const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", handle, ...args]) as Promise<Record<string, any>>;
const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
const click = (name: string) => ui("click", "--name", name);
const type = (name: string, text: string) => ui("type", "--name", name, "--text", text);
const press = (keys: string) => ui("press", "--keys", keys);
const snapshot = async () => (await ui("snapshot")).snapshot as string;
const poll = async (read: () => Promise<unknown>, expected: unknown, label: string) => {
  const end = Date.now() + 15_000;
  let result;
  do {
    result = await read();
    if (JSON.stringify(result) === JSON.stringify(expected)) return;
    await delay(100);
  } while (Date.now() < end);
  assert.deepEqual(result, expected, label);
};
const visible = (text: string) => poll(async () => (await snapshot()).includes(text), true, text);
const activeLabel = () => evaluate("document.activeElement?.getAttribute('aria-label')");
const dialogOpen = () => evaluate("[...document.querySelectorAll('[role=dialog]')].some(e => e.querySelector('h2')?.textContent === 'Command allowlist')");
const evidenceDir = resolve(".omb-scratch/verify-evidence/command-allowlist");
mkdirSync(evidenceDir, { recursive: true });
const screenshot = (name: string) => ui("screenshot", "--out", resolve(evidenceDir, `${name}.png`));

// A successful ui verb validates that the handle still owns a live fixture.
await visible("Message Pepper");
const info = JSON.parse(readFileSync(handle, "utf8")) as { botId: string; logPath: string };
const path = `/api/bots/${info.botId}/command-allowlist`;
const rules = () => evaluate(`fetch(${JSON.stringify(path)}).then(r => r.json())`);
const before = await rules();
assert.equal(before.rules.length, 0, "run this recipe against a fresh UI fixture");
assert.equal(before.supported, true, "the fixture Claude provider supports structured approvals");
const trigger = await evaluate("[...document.querySelectorAll('button[aria-haspopup=menu]')].map(e => e.getAttribute('aria-label')).find(name => name && /^(Ask for approval|Approve for me|Auto-accept edits|Full access) for /.test(name))");
assert.equal(typeof trigger, "string");
await click(trigger);
const menu = await snapshot();
assert.ok(menu.includes('menuitem "Command allowlist"'));
// Full access is unavailable in the ordinary browser preview. Its exact
// placement and unchanged callback are covered by the selector unit test.
await click("Command allowlist");
await visible("No commands saved yet.");
assert.equal(await activeLabel(), "Close command allowlist");
assert.equal(await evaluate("[...document.querySelectorAll('label')].find(e => e.textContent.trim() === 'Working folder')?.querySelector('input')?.value"), before.context.cwd);
await press("Shift+Tab");
assert.equal(await evaluate("document.activeElement?.closest('label')?.textContent.trim()"), "Working folder");
await press("Tab");
assert.equal(await activeLabel(), "Close command allowlist");
console.log("PASS composer opens allowlist with server folder, initial focus and keyboard containment");

const command = "git status --short";
await type("Command", command);
await click("Add command");
await visible(`Remove allowed command: ${command}`);
const saved = await rules();
assert.deepEqual(saved.rules.map(({ id: _id, ...rule }: { id: string }) => rule), [{
  command, cwd: before.context.cwd, providerInstanceId: before.context.providerInstanceId,
}]);
await screenshot("saved-command");
await press("Escape");
await poll(dialogOpen, false, "Escape closes the allowlist");
assert.equal(await activeLabel(), trigger);
await click(trigger);
await click("Command allowlist");
await visible(`Remove allowed command: ${command}`);
await click(`Remove allowed command: ${command}`);
await visible("No commands saved yet.");
assert.equal((await rules()).rules.length, 0);
await press("Escape");
console.log("PASS add persists across close/reopen, removal reaches the API, Escape restores composer focus");

const profileSnapshot = await ui("snapshot", "--interactive");
const profileRef = Object.entries(profileSnapshot.refs as Record<string, { name: string; role: string }>)
  .find(([, entry]) => entry.role === "button" && entry.name === "Open Pepper's profile")?.[0];
assert.ok(profileRef, "profile button is present");
await ui("click", "--ref", `@${profileRef}`);
await click("Permissions");
await click("Manage command allowlist");
await visible("No commands saved yet.");
await press("Escape");
await poll(dialogOpen, false, "nested allowlist closes");
assert.equal(await evaluate("document.activeElement?.textContent"), "Manage command allowlist");
assert.ok((await snapshot()).includes('button "Close settings"'));
console.log("PASS settings management opens the same allowlist and Escape leaves settings open");

// Restrict the stubs to the exact allowlist GET; all real writes and the
// successful retry still pass through the isolated server.
await evaluate(`(() => {
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    if (String(input) === ${JSON.stringify(path)} && (!init?.method || init.method === 'GET')) {
      window.fetch = original;
      const data = await original(input, init).then(r => r.json());
      return Response.json({ ...data, supported: false });
    }
    return original(input, init);
  };
  return true;
})()`);
await click("Manage command allowlist");
await visible("This provider cannot use saved command approvals.");
assert.ok(!(await snapshot()).includes('textbox "Command"'));
await screenshot("unsupported-provider");
await press("Escape");
await evaluate(`(() => {
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (String(input) === ${JSON.stringify(path)} && (!init?.method || init.method === 'GET')) {
      window.fetch = original;
      return Promise.resolve(Response.json({ error: 'Fixture allowlist read failed' }, { status: 503 }));
    }
    return original(input, init);
  };
  return true;
})()`);
await click("Manage command allowlist");
await visible("Fixture allowlist read failed");
await click("Retry");
await visible("No commands saved yet.");
await screenshot("settings-allowlist");
console.log("PASS unsupported provider has no add form; failed load retries against the real API");
const consoleResult = await ui("console");
assert.deepEqual((consoleResult.messages as Array<{ type: string }>).filter((message) => message.type === "error"), [], "renderer console has no errors");
console.log(JSON.stringify({ ok: true, handle, evidenceDir, logPath: info.logPath, note: "Fixture remains running for inspection." }, null, 2));

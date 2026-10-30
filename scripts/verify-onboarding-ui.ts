// Assert the first-run workflow against a handle from `control-omb ui launch`.
// The handle gate refuses live-app URLs and stopped fixtures. All profile,
// bot and onboarding writes below stay inside that launch's disposable home.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runControlOmb } from "./control-omb.ts";
import { TOUR_STEPS } from "../src/lib/guided-tour.ts";

const handle = process.argv[2];
if (!handle) throw new Error("Usage: node --experimental-strip-types scripts/verify-onboarding-ui.ts /path/to/fixture/ui.json");
const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", handle, ...args]) as Promise<Record<string, any>>;
const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
const click = async (name: string) => {
  // Let the 320ms spotlight transition land before sending a real pointer
  // click; the browser CLI does not wait for moving controls to stabilize.
  await delay(400);
  return ui("click", "--name", name);
};
const type = (name: string, text: string) => ui("type", "--name", name, "--text", text);
const snapshot = async () => (await ui("snapshot")).snapshot as string;
const config = () => evaluate("fetch('/api/config').then(r => r.json())");
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
const textVisible = (text: string) => poll(async () => (await snapshot()).includes(text), true, text);
const evidence = resolve(".omb-scratch/verify-evidence/onboarding");
mkdirSync(evidence, { recursive: true });
const screenshot = (name: string) => ui("screenshot", "--out", resolve(evidence, `${name}.png`));
const openSettings = async () => {
  await click("Onboarding fixture");
  await click("Settings");
  // Simple Settings keeps the replays with the version, on Updates; it reopens on the page it was left on.
  await delay(400);
  if (!(await snapshot()).includes("Replay welcome tour")) await click("Updates");
  await textVisible("Replay welcome tour");
};
const holdConfigWrite = () => evaluate(`(() => {
  const original = window.fetch.bind(window);
  window.heldWrites = 0;
  window.fetch = (input, init) => {
    if (String(input) === '/api/config' && init?.method === 'PUT') {
      window.heldWrites++;
      window.fetch = original;
      return new Promise(resolve => { window.releaseWrite = () => resolve(original(input, init)); });
    }
    return original(input, init);
  };
  return true;
})()`);

// The standard fixture suppresses onboarding. This opt-in entry skips that
// suppression; only this fixture browser's localStorage is cleared. The name
// is the one the person already gave (the welcome no longer asks for it).
await evaluate("fetch('/api/config', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({profile:{name:'Onboarding fixture'}})}).then(r => r.ok)");
// The standard fixture has MausBot met already (no first-launch card); a new install's has met nobody yet.
await evaluate("fetch('/api/bots').then(r => r.json()).then(data => Promise.all(data.bots.filter(bot => bot.defaultBot).map(bot => fetch('/api/bots/' + bot.id, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({welcomed:false})}).then(r => r.ok)))).then(oks => oks.length > 0 && oks.every(Boolean))");
// A new install opens in Simple mode; this page's own writes after the clear would otherwise read as an earlier run.
await evaluate("localStorage.clear(); sessionStorage.clear(); localStorage.setItem('omb-advanced-mode', '0'); setTimeout(() => { location.search = '?onboarding=1'; }, 0); true");
await textVisible("Meet OpenMausBot");
await evaluate("document.documentElement.dataset.reducedMotion = 'true'; true");
await screenshot("welcome");
// Two screens, no form: the first asks nothing and shows no steps, Back or Skip.
assert.equal(await evaluate("document.querySelectorAll('[data-welcome] input').length"), 0, "no field on the first screen");
for (const gone of ["Step 1", "Back", "Skip", "Your name"]) assert.equal((await snapshot()).includes(gone), false, gone);
await click("Next");
await textVisible("Introducing your Chief of Staff");
// A reload on the second screen comes back to it.
await evaluate("setTimeout(() => location.reload(), 0); true");
await textVisible("Introducing your Chief of Staff");
await screenshot("chief");
console.log("PASS the first run is two screens, and a reload keeps the second");

// The completion write failing never keeps the person out of the chat.
await evaluate(`(() => {
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (String(input) === '/api/config' && init?.method === 'PUT') {
      window.fetch = original;
      return Promise.resolve(new Response(JSON.stringify({error:'Fixture save rejected'}), {status:503}));
    }
    return original(input, init);
  };
  return true;
})()`);
await click("Create Chief of Staff");
await poll(() => evaluate("document.querySelectorAll('[data-welcome]').length"), 0, "Create lands in the chat");
// The welcome lands in the chat with the Chief (the server's first bot): its first messages, no AI asked.
const first = await evaluate("fetch('/api/bots').then(r => r.json()).then(data => data.bots.find(bot => bot.chiefOfStaff && !bot.hidden))");
assert.ok(first?.name, "the Chief");
assert.equal(first.welcomed, true, "MausBot is introduced, so its old first-launch card never comes");
const composer = `Message ${first.name}`;
await textVisible(composer);
await textVisible(`Hey! I'm ${first.name}. I'm new here.`);
await textVisible("I looked around");
const followups = await evaluate(`fetch('/api/threads/${first.threadId}/messages?limit=20').then(r => r.json()).then(data => data.messages.filter(message => message.helperFollowup).length)`);
assert.equal(followups, 1, "its follow-up is written once, as a message the model reads");
assert.equal((await config()).profile.email, "", "the welcome saves no email");
console.log("PASS Create lands in the Chief's chat with its first messages, though the save failed");

const starter = await evaluate("fetch('/api/bots').then(r => r.json()).then(data => data.bots.find(bot => bot.name === 'Pepper'))");
assert.ok(starter?.modelSelection?.instanceId && starter.modelSelection.model, "starter has a model without opening the picker");
const engines = await evaluate("fetch('/api/instances').then(r => r.json()).then(data => data.instances)");
const selected = engines.find((engine: any) => engine.instanceId === starter.modelSelection.instanceId);
assert.equal(selected?.snapshot.state, "available", "starter uses an available provider");
assert.notEqual(selected?.snapshot.authenticated, false, "starter uses a connected account");
assert.equal(starter.modelSelection.model, selected.models.default);
// The failed save left the server's record empty: a browser without this one's local mark shows the welcome again,
// and this time it is saved.
// MausBot has met the person by now, so the Chief step is not shown again: Next lands in the Chief's chat.
await evaluate("localStorage.removeItem('omb-email-gate'); setTimeout(() => location.reload(), 0); true");
await textVisible("Meet OpenMausBot");
await click("Next");
await poll(() => evaluate("document.querySelectorAll('[data-welcome]').length"), 0, "Next lands in the chat");
await textVisible(composer);
await poll(async () => Boolean((await config()).onboarding.completedAt), true, "welcome completion saved");
assert.ok((await config()).onboarding.hintsSeen.includes("met-chief-v1"), "the first chat is marked to stay quiet");
await delay(1500);
assert.equal(await evaluate("document.querySelectorAll('[data-welcome], [data-tour-card]').length"), 0, "no app tour after the welcome");
await evaluate("setTimeout(() => location.reload(), 0); true");
await textVisible(composer);
await delay(1500);
assert.equal(await evaluate("document.querySelectorAll('[data-welcome], [data-tour-card]').length"), 0, "no app tour after a reload");
assert.equal((await config()).onboarding.hintsSeen.filter((id: string) => id.startsWith("tour.")).length, 0, "no tour step was shown");
await screenshot("chat");
console.log("PASS the first run lands in the chat with the Chief; the app tour never starts by itself, nor after a reload");

await type(composer, "FIRST_MESSAGE_AFTER_ONBOARDING_7J");
await ui("press", "--keys", "Enter");
await poll(() => evaluate(`fetch('/api/threads/${first.threadId}/messages?limit=20').then(r => r.json()).then(data => data.messages.some(message => message.role === 'bot' && message.kind === 'text' && message.turnSucceeded === true))`), true, "first onboarding message completes");
console.log("PASS connected default selected automatically; first message succeeds without a model pick");

// The app tour still runs from Settings. Complete every live-interface step and verify its server record. A missing
// optional browser tab may skip itself, but every required anchor must work.
await openSettings();
await click("Replay app tour");
for (const step of TOUR_STEPS) {
  if ((await config()).onboarding.hintsSeen.includes(step.id)) continue;
  await poll(() => evaluate("Boolean(document.querySelector('[data-tour-card] button'))"), true, step.id);
  await screenshot(step.id);
  await click(step.id === "tour.done" ? "Finish" : "Next");
  await poll(async () => (await config()).onboarding.hintsSeen.includes(step.id), true, `saved ${step.id}`);
}
await poll(() => evaluate("document.querySelectorAll('[data-tour-card]').length"), 0, "tour closed");
await evaluate("setTimeout(() => location.reload(), 0); true");
await textVisible(composer);
assert.equal(await evaluate("document.querySelectorAll('[data-welcome], [data-tour-card]').length"), 0);
console.log("PASS full app tour from Settings, saved progress, reload stays dismissed");

await openSettings();
await click("Replay app tour");
await textVisible("This is where you talk to your bots");
await holdConfigWrite();
await click("Next");
await poll(() => evaluate("window.heldWrites"), 1, "Next pending");
await click("Skip tour");
await poll(() => evaluate("document.querySelectorAll('[data-tour-card]').length"), 0, "Skip closes immediately");
await evaluate("window.releaseWrite(); true");
await poll(async () => (await config()).onboarding.hintsSeen.filter((id: string) => id.startsWith("tour.")).length, TOUR_STEPS.length, "Skip survives in-flight Next");
console.log("PASS Settings replay and Skip queued behind slow Next");

await openSettings();
await click("Replay welcome tour");
await textVisible("Meet OpenMausBot");
await holdConfigWrite();
await click("Next");
await poll(() => evaluate("document.querySelectorAll('[data-welcome]').length"), 0, "slow completion cannot trap welcome");
await evaluate("window.releaseWrite(); true");
console.log("PASS welcome replay can close while persistence is pending");
await poll(async () => Boolean((await config()).onboarding.completedAt), true, "welcome save completed");

// An upgraded install can have only the legacy browser gate. Replay still
// works without a new welcome completion, and failures keep Settings open.
await evaluate("fetch('/api/config', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({onboarding:{completedAt:'', version:0}})}).then(r=>r.ok)");
await evaluate("setTimeout(() => location.reload(), 0); true");
await textVisible(composer);
await openSettings();
await evaluate(`(() => {
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (String(input) === '/api/config' && init?.method === 'PUT') {
      window.fetch = original;
      return Promise.resolve(new Response('{}', {status:503}));
    }
    return original(input, init);
  };
  return true;
})()`);
await click("Replay app tour");
await textVisible("Couldn't save your progress");
await click("Replay app tour");
await textVisible("This is where you talk to your bots");
await click("Skip tour");
await poll(async () => (await config()).onboarding.hintsSeen.filter((id: string) => id.startsWith("tour.")).length, TOUR_STEPS.length, "legacy replay saved");
console.log("PASS legacy-install replay and failed replay retry");
await screenshot("complete");
console.log(JSON.stringify({ ok: true, evidence, config: (await config()).onboarding }));

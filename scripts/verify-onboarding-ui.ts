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
// suppression; only this fixture browser's localStorage is cleared.
await evaluate("localStorage.clear(); sessionStorage.clear(); setTimeout(() => { location.search = '?onboarding=1'; }, 0); true");
await textVisible("Your name");
await evaluate("document.documentElement.dataset.reducedMotion = 'true'; true");
await screenshot("welcome");
// The greeting asks for a name only; the email is asked once, by the separate product-updates question.
assert.equal(await evaluate("document.querySelectorAll('.welcome-card input').length"), 1, "one field: the name");
assert.equal(await evaluate("document.querySelectorAll('.welcome-card input[type=email]').length"), 0, "no email field");
await type("Your name", "Onboarding fixture");
// A reload in the middle of the welcome resumes with what was typed.
await evaluate("setTimeout(() => location.reload(), 0); true");
await textVisible("Your name");
await poll(() => evaluate("document.querySelector('.welcome-card input[type=text]')?.value"), "Onboarding fixture", "the name kept across a reload");
console.log("PASS the greeting asks for a name only, and a reload keeps the step and the name");
await evaluate(`(() => {
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (String(input) === '/api/config' && init?.method === 'PUT') {
      window.fetch = original;
      return Promise.resolve(new Response(JSON.stringify({error:'Fixture profile rejected'}), {status:503}));
    }
    return original(input, init);
  };
  return true;
})()`);
await click("Continue");
await textVisible("Couldn't save your details");
assert.equal(await evaluate("document.querySelector('.welcome-card input[type=text]').value"), "Onboarding fixture");
await click("Continue");
// The fixture's Claude already works, so the greeting is the whole welcome: no Connect an AI, reel, phone or first-bot step.
await poll(() => evaluate("document.querySelectorAll('.welcome-card').length"), 0, "the one-step welcome ends");
assert.equal((await config()).profile.name, "Onboarding fixture");
assert.equal((await config()).profile.email, "", "the welcome saves no email");
console.log("PASS profile failure preserves input; retry persists, then the welcome ends");

const starter = await evaluate("fetch('/api/bots').then(r => r.json()).then(data => data.bots.find(bot => bot.name === 'Pepper'))");
assert.ok(starter?.modelSelection?.instanceId && starter.modelSelection.model, "starter has a model without opening the picker");
const engines = await evaluate("fetch('/api/instances').then(r => r.json()).then(data => data.instances)");
const selected = engines.find((engine: any) => engine.instanceId === starter.modelSelection.instanceId);
assert.equal(selected?.snapshot.state, "available", "starter uses an available provider");
assert.notEqual(selected?.snapshot.authenticated, false, "starter uses a connected account");
assert.equal(starter.modelSelection.model, selected.models.default);
// The welcome lands in the chat with the Chief (the server's first bot).
const first = await evaluate("fetch('/api/bots').then(r => r.json()).then(data => data.bots.find(bot => bot.chiefOfStaff && !bot.hidden))");
assert.ok(first?.name, "the first bot");
const composer = `Message ${first.name}`;
await textVisible(composer);
await poll(async () => Boolean((await config()).onboarding.completedAt), true, "welcome completion saved");
await delay(1500);
assert.equal(await evaluate("document.querySelectorAll('.welcome-card, [data-tour-card]').length"), 0, "no app tour after the welcome");
await evaluate("setTimeout(() => location.reload(), 0); true");
await textVisible(composer);
await delay(1500);
assert.equal(await evaluate("document.querySelectorAll('.welcome-card, [data-tour-card]').length"), 0, "no app tour after a reload");
assert.equal((await config()).onboarding.hintsSeen.filter((id: string) => id.startsWith("tour.")).length, 0, "no tour step was shown");
await screenshot("chat");
console.log("PASS short welcome lands in the chat with the first bot; the app tour never starts by itself, nor after a reload");

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
assert.equal(await evaluate("document.querySelectorAll('.welcome-card, [data-tour-card]').length"), 0);
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
await textVisible("Your name");
await holdConfigWrite();
await click("Skip setup");
await poll(() => evaluate("document.querySelectorAll('.welcome-card').length"), 0, "slow completion cannot trap welcome");
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

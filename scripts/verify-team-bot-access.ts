// Who can see, chat with and change each bot, in the real app on a real Team Cloud: Acme's Owner, an Admin (Ada) and
// four Users, each paired with the Admin's signed claim, a synthetic Claude CLI, disposable homes. Every page is the
// whole app in a headless Chrome whose requests reach the Team Cloud as that person.
// Run: node --experimental-strip-types scripts/verify-team-bot-access.ts --shots <dir> [--only <shot,shot>]
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchCloudSendFixture } from "./testing/cloud-send-fixture.ts";
import { mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";

const at = process.argv.indexOf("--shots");
if (at === -1) throw new Error("--shots <dir> is required");
const shots = resolve(process.argv[at + 1] ?? "");
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt === -1 ? null : new Set((process.argv[onlyAt + 1] ?? "").split(",").filter(Boolean));
const CHROME = process.env.OMB_CDP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [WIDTH, HEIGHT] = [1280, 800];
const PHONE = { width: 390, height: 844 };
const SUBJECT = /^\/api\/(?:bots|threads|groups|routines)\//;
/** The app's time-limited offer opens over the sidebar; its own Not now closes it. */
const DISMISS_OFFER = `(() => { const button = [...document.querySelectorAll('[data-notice="boat-offer"] button')].find((entry) => entry.textContent.trim() === "Not now");
  button?.click(); return Boolean(button); })()`;

const CROWD = ["frank", "gina", "hugo", "iris", "jon", "kim"].map((name) => ({ email: `${name}@acme.test`, role: "member" as const }));

const PEOPLE = {
  olive: { email: "olive@acme.test", role: "owner" as const },
  ada: { email: "ada@acme.test", role: "admin" as const },
  bob: { email: "bob@acme.test", role: "member" as const },
  cara: { email: "cara@acme.test", role: "member" as const },
  dan: { email: "dan@acme.test", role: "member" as const },
  eve: { email: "eve@acme.test", role: "member" as const },
};
type Who = keyof typeof PEOPLE;

/** One page of a headless Chrome over the DevTools protocol. */
async function openChrome(profile: string) {
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
  let port = "";
  for (let i = 0; i < 100 && !port; i++) {
    await delay(100);
    try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]!.trim(); } catch {}
  }
  if (!port) { chrome.kill(); throw new Error("Chrome did not start"); }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const socket = new WebSocket(targets.find((target) => target.type === "page")!.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let next = 0;
  const waiting = new Map<number, { done: (value: any) => void; fail: (error: Error) => void }>();
  const refused: string[] = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const response = message.method === "Network.responseReceived" ? message.params.response : null;
    // A member is refused the admin's own lists (engines, apps) as before; what counts here is a bot, room or chat.
    if (response && response.status >= 400 && SUBJECT.test(new URL(response.url).pathname)) refused.push(`${response.status} ${new URL(response.url).pathname}`);
    const call = waiting.get(message.id);
    if (!call) return;
    waiting.delete(message.id);
    if (message.error) call.fail(new Error(message.error.message)); else call.done(message.result);
  };
  const send = (method: string, params: object = {}) => new Promise<any>((done, fail) => {
    const id = ++next;
    waiting.set(id, { done, fail });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
  const until = async (expression: string, what: string, timeoutMs = 30_000) => {
    const end = Date.now() + timeoutMs;
    while (!(await evaluate(expression).catch(() => false))) {
      if (Date.now() > end) throw new Error(`${what} never showed`);
      await delay(200);
    }
  };
  await send("Network.enable");
  return {
    evaluate, until,
    /** The page's /api requests the server refused since the last call. */
    refusals: () => refused.splice(0),
    async open(url: string, size: { width: number; height: number } = { width: WIDTH, height: HEIGHT }) {
      await send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2, mobile: false });
      await send("Page.navigate", { url });
      await until("Boolean(document.querySelector('[data-sidebar-bot-row]'))", "the sidebar", 60_000);
    },
    async click(selector: string, what = selector) {
      await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, what);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
    },
    async shoot(file: string) {
      await delay(700);
      if (await evaluate(DISMISS_OFFER)) await delay(500);
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log(file);
    },
    close() { socket.close(); chrome.kill(); },
  };
}

const before = process.argv.includes("--before");
const fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme" } });
const team = fx.team!;
const token = {} as Record<Who, string>;
const profile = mkdtempSync(join(tmpdir(), "omb-team-access-chrome-"));
let chrome: Awaited<ReturnType<typeof openChrome>> | undefined;
let ui: MountedPreview | undefined;
try {
  for (const who of Object.keys(PEOPLE) as Who[]) token[who] = (await team.pair(PEOPLE[who])).token!;
  const as = async (who: Who, method: string, path: string, body?: unknown) => {
    const answer = await team.as(token[who], method, path, body);
    if (answer.status >= 400) throw new Error(`${method} ${path} as ${who}: ${answer.status} ${JSON.stringify(answer.body)}`);
    return answer.body;
  };
  const payroll = (await as("ada", "POST", "/api/bots", { name: "Payroll", title: "Answers pay questions", color: "teal" })).bot as { id: string; threadId: string };
  const helpdesk = (await as("ada", "POST", "/api/bots", { name: "Helpdesk", title: "IT questions", color: "blue", visibility: "everyone" })).bot as { id: string };
  if (before) await as("ada", "PATCH", `/api/bots/${payroll.id}`, { visibility: { people: [PEOPLE.bob.email, PEOPLE.cara.email, PEOPLE.dan.email] } });
  else await as("ada", "PUT", `/api/bots/${payroll.id}/access`, { everyone: "none", people: { [PEOPLE.bob.email]: "view", [PEOPLE.cara.email]: "chat", [PEOPLE.dan.email]: "edit" } });
  const sales = (await as("ada", "POST", "/api/bots", { name: "Sales notes", title: "Keeps the deal notes", color: "orange" })).bot as { id: string };
  await as("ada", "PUT", `/api/bots/${sales.id}/access`, { everyone: "view", people: { [PEOPLE.bob.email]: "edit" } });
  const recruiting = (await as("ada", "POST", "/api/bots", { name: "Recruiting", title: "Screens applicants", color: "purple" })).bot as { id: string };
  await as("ada", "PUT", `/api/bots/${recruiting.id}/access`, { everyone: "none", people: { [PEOPLE.bob.email]: "view", [PEOPLE.cara.email]: "chat", [PEOPLE.dan.email]: "chat", [PEOPLE.eve.email]: "chat" } });
  await as("ada", "POST", `/api/bots/${payroll.id}/messages`, { text: "When does payroll run this month?" });
  for (let i = 0; i < 150; i++) {
    const bots = (await as("ada", "GET", "/api/bots")).bots as Array<{ id: string; busy?: boolean }>;
    if (!bots.find((bot) => bot.id === payroll.id)?.busy) break;
    await delay(200);
  }
  for (const who of Object.keys(PEOPLE) as Who[]) {
    const own = ((await as(who, "GET", "/api/bots")).bots as Array<{ id: string; defaultBot?: { person?: string } }>).find((bot) => bot.defaultBot?.person === PEOPLE[who].email);
    if (own) await as(who, "PATCH", `/api/bots/${own.id}`, { welcomed: true });
  }

  mkdirSync(shots, { recursive: true });
  chrome = await openChrome(profile);
  const page = chrome;
  const row = `[data-sidebar-bot-row="${payroll.id}"]`;
  const openPayroll = async () => {
    await page.click(row, "Payroll's row");
    await page.until("document.querySelector('[data-chathead-identity]')?.textContent.includes('Payroll') === true", "Payroll's chat");
  };
  const openPanel = async () => {
    await page.evaluate("document.querySelector('[data-chathead-identity] button, [data-chathead-pill]')?.click(); true");
    await page.until("Boolean(document.querySelector('[data-panel-share], [data-share-bot-button]'))", "the bot panel");
  };
  const openShare = async () => {
    await openPayroll(); await openPanel(); await page.click("[data-share-bot-button]");
    await page.until("Boolean(document.querySelector('[data-share-bot]'))", "the Share dialog");
  };
  const openMenu = async (label: string) => {
    await page.click(`[data-share-bot] button[aria-label="${label}"], [data-access-overview] button[aria-label="${label}"]`, label);
    await page.until("Boolean(document.querySelector('[role=menu]'))", "its menu");
  };
  const openSettings = async () => {
    await page.until(`(() => { const trigger = document.querySelector("[data-sidebar-account]") ?? [...document.querySelectorAll('button')].find((entry) => entry.textContent.includes("ada@acme.test") || /^(Ada|ada@acme)/.test(entry.getAttribute("aria-label") ?? ""));
      (trigger ?? document.querySelector('.lucide-chevron-left')?.closest('button'))?.click(); return Boolean(trigger); })()`, "the account menu");
    await page.until(`(() => { const item = [...document.querySelectorAll('[role=menuitem]')].find((entry) => entry.textContent.trim() === "Settings"); item?.click(); return Boolean(item); })()`, "Settings in the menu");
    await page.until(`(() => { const entry = document.querySelector("[data-settings-page='botAccess'], [data-settings-section='botAccess']"); entry?.click(); if (entry) return true;
      const picker = document.querySelector('select[aria-label="Settings"]'); if (!picker) return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(picker, "botAccess"); picker.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`, "Bot access in the rail");
    await page.until("Boolean(document.querySelector('[data-access-overview]'))", "Bot access");
  };
  const byPerson = async () => {
    await openSettings();
    await page.click("[data-access-listing='person']", "By person");
    await page.until("Boolean(document.querySelector('[data-access-person]'))", "the people");
  };
  const bobsBots = async () => {
    await byPerson();
    await page.click('[data-access-person="bob@acme.test"]', "Bob's row");
    await page.until("Boolean(document.querySelector('[data-access-person-bot]'))", "Bob's bots");
  };
  type Shot = { name: string; who: Who; query: string; size?: { width: number; height: number }; act: () => Promise<void>; after?: () => Promise<void> };
  const SHOTS: Shot[] = before ? [
    { name: "before-share-menu", who: "ada", query: "mode=simple", act: async () => {
      await openPayroll(); await openPanel(); await page.click("[data-panel-share]");
      await page.until("Boolean(document.querySelector('[role=menu]'))", "the Share menu");
    } },
    { name: "before-visibility", who: "ada", query: "mode=advanced", act: async () => {
      await openPayroll();
      await page.evaluate("document.querySelector('[data-chathead-pill] button')?.click(); true");
      await page.click("[data-bot-settings-section='visibility'] button", "the visibility section");
      await page.until("Boolean(document.querySelector('[data-bot-visibility]'))", "Who can see it");
      await page.evaluate("document.querySelector('[data-bot-visibility]').scrollIntoView({ block: 'center' }); true");
    } },
    { name: "before-member-bob", who: "bob", query: "mode=simple", act: openPayroll },
  ] : [
    { name: "share-dialog-admin", who: "ada", query: "mode=simple", act: openShare },
    { name: "share-dialog-admin-dark", who: "ada", query: "mode=simple&skin=midnight", act: openShare },
    { name: "share-dialog-level-menu", who: "ada", query: "mode=simple", act: async () => { await openShare(); await openMenu("What Bob can do"); } },
    { name: "share-dialog-level-menu-dark", who: "ada", query: "mode=simple&skin=midnight", act: async () => { await openShare(); await openMenu("What Bob can do"); } },
    { name: "share-dialog-more-menu", who: "bob", query: "mode=simple", act: async () => { await openShare(); await openMenu("More"); } },
    { name: "share-dialog-make-owner", who: "ada", query: "mode=simple", act: async () => {
      await openShare(); await openMenu("What Bob can do");
      await page.click('[role=menu] [data-menu-key="owner"]', "Make owner");
      await page.until("Boolean(document.querySelector('[data-share-make-owner]'))", "the confirmation");
    } },
    { name: "share-dialog-add-person", who: "ada", query: "mode=simple", act: async () => {
      await openShare();
      await page.evaluate(`(() => { const field = document.querySelector('[data-share-bot] input'); field.focus(); field.click(); return true; })()`);
      await page.until("Boolean(document.querySelector('[data-share-suggestion]'))", "Eve in the list");
    } },
    { name: "share-dialog-undo-toast", who: "ada", query: "mode=simple", act: async () => {
      await openShare(); await openMenu("What Bob can do");
      await page.click('[role=menu] [data-menu-key="chat"]', "Can chat");
      await page.until("Boolean(document.querySelector('[data-access-toast]'))", "the Undo toast");
    }, after: async () => {
      await page.click("[data-access-toast] button", "Undo");
      await page.until("!document.querySelector('[data-access-toast]')", "the sharing put back");
    } },
    { name: "share-dialog-advanced-dark", who: "ada", query: "mode=advanced&skin=midnight", act: async () => {
      await openPayroll();
      await page.evaluate("document.querySelector('[data-chathead-pill] button')?.click(); true");
      await page.click("[data-share-bot-button]");
      await page.until("Boolean(document.querySelector('[data-share-bot]'))", "the Share dialog");
    } },
    { name: "share-dialog-390", who: "ada", query: "mode=simple", size: PHONE, act: openShare },
    { name: "share-dialog-level-menu-390", who: "ada", query: "mode=simple", size: PHONE, act: async () => { await openShare(); await openMenu("What Bob can do"); } },
    { name: "member-view-bob", who: "bob", query: "mode=simple", act: async () => {
      await openPayroll();
      await page.until("Boolean(document.querySelector('[data-testid=view-only-composer]'))", "the view-only line");
    } },
    { name: "member-view-bob-share", who: "bob", query: "mode=simple", act: async () => {
      await openShare();
      await page.until("Boolean(document.querySelector('[data-share-yours]'))", "Bob's own level");
    } },
    { name: "member-view-bob-share-dark", who: "bob", query: "mode=simple&skin=midnight", act: async () => {
      await openShare();
      await page.until("Boolean(document.querySelector('[data-share-yours]'))", "Bob's own level");
    } },
    { name: "member-view-bob-share-390", who: "bob", query: "mode=simple", size: PHONE, act: async () => {
      await openShare();
      await page.until("Boolean(document.querySelector('[data-share-yours]'))", "Bob's own level");
    } },
    { name: "member-chat-cara", who: "cara", query: "mode=simple", act: openPayroll },
    { name: "member-edit-dan-share", who: "dan", query: "mode=simple", act: async () => {
      await openShare();
      await page.until("Boolean(document.querySelector('[data-share-bot] input'))", "Dan's Share dialog");
    } },
    { name: "member-none-eve", who: "eve", query: "mode=simple", act: async () => {
      await page.until(`!document.querySelector(${JSON.stringify(row)})`, "a sidebar without Payroll");
    } },
    { name: "overview-admin", who: "ada", query: "mode=simple", act: openSettings },
    { name: "overview-admin-advanced-dark", who: "ada", query: "mode=advanced&skin=midnight", act: openSettings },
    { name: "overview-admin-390", who: "ada", query: "mode=simple", size: PHONE, act: openSettings },
    { name: "overview-share-everyone", who: "ada", query: "mode=simple", act: async () => {
      await openSettings();
      await page.click(`[data-access-row="${sales.id}"]`, "the Sales notes row");
      await page.until("Boolean(document.querySelector('[data-share-bot]'))", "the Share dialog");
    } },
    { name: "overview-by-person", who: "ada", query: "mode=simple", act: byPerson },
    { name: "overview-by-person-dark", who: "ada", query: "mode=simple&skin=midnight", act: byPerson },
    { name: "overview-by-person-390", who: "ada", query: "mode=simple", size: PHONE, act: byPerson },
    { name: "overview-person-bots", who: "ada", query: "mode=simple", act: async () => { await bobsBots(); await delay(500); await openMenu("What Bob can do with Payroll"); } },
    { name: "overview-person-bots-dark", who: "ada", query: "mode=simple&skin=midnight", act: bobsBots },
    { name: "overview-person-bots-390", who: "ada", query: "mode=simple", size: PHONE, act: bobsBots },
    { name: "ask-bob", who: "bob", query: "mode=simple", act: async () => {
      await openPayroll();
      await page.until("Boolean(document.querySelector('[data-ask-to-chat]'))", "Ask to chat");
    } },
    { name: "ask-bob-asked", who: "bob", query: "mode=simple", act: async () => {
      await openPayroll();
      await page.click("[data-ask-to-chat]", "Ask to chat");
      await page.until("Boolean(document.querySelector('[data-ask-to-chat=asked]'))", "Asked");
    } },
    { name: "ask-card-ada-inbox", who: "ada", query: "mode=simple", act: async () => {
      await page.click('[data-sidebar-people] [data-person="ada@acme.test"]', "Ada's own row");
      await page.until("Boolean([...document.querySelectorAll('[data-inbox-choice], button')].find((entry) => entry.textContent.trim() === 'Allow'))", "the Allow button");
    }, after: async () => {
      await page.evaluate("[...document.querySelectorAll('[data-inbox-choice], button')].find((entry) => entry.textContent.trim() === 'Allow').click(); true");
      await page.until("![...document.querySelectorAll('[data-inbox-choice], button')].some((entry) => entry.textContent.trim() === 'Allow' && !entry.disabled)", "the ask answered");
    } },
    { name: "ask-allowed-bob", who: "bob", query: "mode=simple", act: async () => {
      await openPayroll();
      await page.until("!document.querySelector('[data-testid=view-only-composer]') && Boolean(document.querySelector('textarea'))", "Bob's composer");
    } },
    { name: "share-dialog-many-people", who: "ada", query: "mode=simple", act: async () => {
      await crowd();
      await page.open(`${ui!.previewUrl}?mode=simple`);
      await openShare();
    } },
    { name: "share-dialog-many-people-390", who: "ada", query: "mode=simple", size: PHONE, act: async () => { await crowd(); await openShare(); } },
    { name: "overview-many-bots", who: "ada", query: "mode=simple", act: async () => { await crowd(); await openSettings(); } },
    { name: "overview-many-bots-390", who: "ada", query: "mode=simple", size: PHONE, act: async () => { await crowd(); await openSettings(); } },
    { name: "share-dialog-made-owner", who: "ada", query: "mode=simple", act: async () => {
      await openSettings();
      await page.click(`[data-access-row="${recruiting.id}"]`, "the Recruiting row");
      await page.until("Boolean(document.querySelector('[data-share-bot]'))", "the Share dialog");
      await openMenu("What Bob can do");
      await page.click('[role=menu] [data-menu-key="owner"]', "Make owner");
      await page.until("Boolean(document.querySelector('[data-share-make-owner]'))", "the confirmation");
      await page.evaluate("[...document.querySelectorAll('[data-share-make-owner] button')].find((entry) => entry.textContent === 'Make owner').click(); true");
      await page.until("!document.querySelector('[data-share-make-owner]') && document.querySelector('[data-share-person]')?.getAttribute('data-share-person') === 'bob@acme.test' && Boolean(document.querySelector('[data-share-person=\"ada@acme.test\"] [aria-haspopup=menu]'))", "Bob as owner, Ada still able to edit");
    } },
    { name: "overview-search-many-people", who: "ada", query: "mode=simple", act: async () => {
      await crowd(); await openSettings();
      await page.evaluate(`(() => { const field = document.querySelector("[data-access-search]"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, "payroll"); field.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      await page.until("document.querySelectorAll('[data-access-row]').length === 1", "the search");
    } },
    { name: "department-access-preview", who: "ada", query: "mode=simple", act: async () => {
      for (const id of [payroll.id, helpdesk.id]) await as("ada", "PATCH", `/api/bots/${id}`, { section: "Finance" });
      await page.click('[aria-label="Actions for Finance department"]', "Finance's menu");
      await page.until(`(() => { const item = [...document.querySelectorAll('[role=menuitem]')].find((entry) => entry.textContent.includes("Set for all bots")); item?.click(); return Boolean(item); })()`, "Set for all bots");
      await page.until(`(() => { const tab = [...document.querySelectorAll('[data-testid=team-settings-dialog] [role=tab]')].find((entry) => entry.textContent.trim() === "Access"); tab?.click(); return Boolean(tab); })()`, "the Access tab");
      const pick = (label: string, value: string) => page.evaluate(`(() => { const field = document.querySelector('[data-testid=team-settings-dialog] select[aria-label="${label}"]'); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
      await pick("Everyone in Acme", "chat");
      await pick("A person", PEOPLE.eve.email);
      await page.until("Boolean(document.querySelector('[data-testid=team-settings-rows]'))", "the preview");
    } },
    { name: "department-access-applied", who: "ada", query: "mode=simple", act: async () => {
      for (const id of [payroll.id, helpdesk.id]) await as("ada", "PATCH", `/api/bots/${id}`, { section: "Finance" });
      await page.click('[aria-label="Actions for Finance department"]', "Finance's menu");
      await page.until(`(() => { const item = [...document.querySelectorAll('[role=menuitem]')].find((entry) => entry.textContent.includes("Set for all bots")); item?.click(); return Boolean(item); })()`, "Set for all bots");
      await page.until(`(() => { const tab = [...document.querySelectorAll('[data-testid=team-settings-dialog] [role=tab]')].find((entry) => entry.textContent.trim() === "Access"); tab?.click(); return Boolean(tab); })()`, "the Access tab");
      const pick = (label: string, value: string) => page.evaluate(`(() => { const field = document.querySelector('[data-testid=team-settings-dialog] select[aria-label="${label}"]'); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
      await pick("Everyone in Acme", "chat");
      await pick("A person", PEOPLE.eve.email);
      await page.until(`(() => { const apply = [...document.querySelectorAll('[data-testid=team-settings-dialog] button')].find((entry) => entry.textContent.startsWith("Apply to")); apply?.click(); return Boolean(apply); })()`, "Apply");
      await page.until("Boolean(document.querySelector('[data-testid=team-settings-dialog] [role=status]')?.textContent.includes('applied'))", "the results");
      const shared = ((await as("ada", "GET", "/api/bots")).bots as Array<{ id: string; access?: { everyone: string; people: Record<string, string> } }>).filter((bot) => bot.id === payroll.id || bot.id === helpdesk.id);
      if (shared.length !== 2 || !shared.every((bot) => bot.access?.everyone === "chat" && bot.access.people[PEOPLE.eve.email] === "chat")) throw new Error(`department access not applied: ${JSON.stringify(shared)}`);
    } },
  ];
  let crowded = false;
  /** Ten people on Payroll and fifty bots, once. */
  async function crowd() {
    if (crowded) return;
    crowded = true;
    const added = Object.fromEntries(CROWD.map((person) => [person.email, "chat" as const]));
    for (const person of CROWD) await team.pair(person);
    await as("ada", "PUT", `/api/bots/${payroll.id}/access`, { everyone: "none", people: { [PEOPLE.bob.email]: "view", [PEOPLE.cara.email]: "chat", [PEOPLE.dan.email]: "edit", [PEOPLE.eve.email]: "view", ...added } });
    for (let i = 1; i <= 46; i++) await as("ada", "POST", "/api/bots", { name: `Bot ${String(i).padStart(2, "0")} with quite a long name for the list`, title: "Filler", color: "teal", visibility: "everyone" });
  }
  let serving: Who | null = null;
  for (const shot of SHOTS.filter((entry) => !only || only.has(entry.name))) {
    if (serving !== shot.who) {
      await ui?.close();
      ui = await mountPreview({ info: { url: team.base } }, { entry: "/scripts/testing/team-access-preview.tsx", route: "/__team-access.html",
        title: "Team bot access", logLevel: "warn", proxyHeaders: { ...fx.edge, authorization: `Bearer ${token[shot.who]}` } });
      serving = shot.who;
    }
    await page.open(`${ui!.previewUrl}?${shot.query}`, shot.size);
    await shot.act().catch(async (error: unknown) => {
      await page.shoot(join(shots, `${shot.name}-failed.png`));
      throw new Error(`${shot.name}: ${error instanceof Error ? error.message : String(error)} (refused: ${page.refusals().join(", ") || "nothing"})`);
    });
    await page.shoot(join(shots, `${shot.name}.png`));
    const refusals = page.refusals();
    if (refusals.length) throw new Error(`${shot.name}: the app was refused ${refusals.join(", ")}`);
    await shot.after?.();
  }
} finally {
  chrome?.close();
  await ui?.close();
  await fx.close();
  await delay(300);
  rmSync(profile, { recursive: true, force: true });
}

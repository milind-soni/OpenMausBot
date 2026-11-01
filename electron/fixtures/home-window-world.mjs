// The window onto My Cloud with fakes on every side (home-window.mjs): the world each home-window test runs in, shared by
// home-window.node-test.mjs and home-window-states.node-test.mjs.
import { createHomeWindow } from "../home-window.mjs";

export const CLOUD = "https://omb-t-1.fly.dev";
export const TEAM = "https://omb-u-acme.fly.dev";
export const ACME = { id: "team-acme", name: "Acme", role: "member", machine: { status: "ready", origin: TEAM } };
export const CLIENT = "https://omb-c-a.fly.dev";
export const CLIENT_A = { id: "c-a", name: "Client A", color: "green", role: "owner", tier: "pro", runsOn: "cloud", status: "ready", origin: CLIENT, teamId: null, primary: false };
export const LOCAL = "http://127.0.0.1:8799";
export const ACCOUNT = { id: "acct-1", email: "person@example.test" };
export const connected = (machine = {}) => ({ status: "connected", account: ACCOUNT, machine: { status: "ready", origin: CLOUD, ...machine } });
export const done = (cloud = {}) => ({ v: 1, phase: "done", cloud: { origin: CLOUD, account: ACCOUNT.id, machine: CLOUD, ...cloud }, doneAt: 1 });
export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * The window onto My Cloud with fakes on every side: the journal, this computer's freeze marker, the MausBot Cloud
 * sign-in (its power word, wake, pairing code), My Cloud's answers (`cloud`), the window (where it went), the startup
 * screen and a manual clock.
 */
export function world({ journal = done(), marker = null, state = connected(), power = null, cloud = {}, team = {}, client = {}, splash = true, url = "", remembered = null, ownMove = null } = {}) {
  const w = {
    journal, marker, state, power, ownMove, clock: 1_000_000, typed: 0, now: () => w.clock,
    cloud: { down: false, signedIn: true, version: "0.1.130", health: 200, wakes: true, ...cloud },
    /** The team's Cloud, answering at TEAM; `gone`: the Admin's team pairing says this person is no longer in it. */
    team: { down: false, signedIn: true, version: "0.1.130", health: 200, gone: false, ...team },
    /** Another Cloud of the person's own, answering at CLIENT; `gone`: the Admin's pairing says it is no longer theirs. */
    client: { down: false, signedIn: true, version: "0.1.130", health: 200, gone: false, ...client },
    went: [], calls: [], fetched: [], pairs: 0, teamPairs: [], ownPairs: [], wakes: 0, waking: [], splash: [], published: [], local: [], reloads: 0, signIns: [],
    remembered, remembers: [], left: [], dropped: [], redeemed: [], rehomes: [], rehomeThrows: false,
    url, timers: [], intervals: [],
    /** Remove from list on the Admin: each Cloud asked about, and what the Admin answers (`removed` takes it off the session's list). */
    hides: [], removeAnswer: "removed",
    /** A page whose load never finishes, by its address (the place answered the look, then nothing). */
    stall: () => false,
  };
  const timers = {
    set: (work, ms) => { const timer = { work, at: w.clock + ms }; w.timers.push(timer); return timer; },
    clear: (timer) => { w.timers = w.timers.filter((entry) => entry !== timer); w.intervals = w.intervals.filter((entry) => entry !== timer); },
    every: (work, ms) => { const timer = { work, ms }; w.intervals.push(timer); return timer; },
  };
  const contents = { id: 7, mainFrame: { get url() { return w.url; } }, getURL: () => w.url, reload: () => { w.reloads++; } };
  w.contents = contents;
  w.window = { isDestroyed: () => false, webContents: contents };
  const account = {
    state: () => w.state,
    power: () => w.power,
    powerOf: (origin) => (origin === CLOUD ? w.power : (w.state?.clouds ?? []).find((cloud) => cloud.origin === origin)?.power ?? null),
    async wakeHome() { w.wakes++; await w.cloud.wakeGate; if (w.cloud.wakes) w.power = { ...w.power, state: "awake" }; return "awake"; },
    setWaking: (on) => w.waking.push(on),
    async pairHome(cloudId = null) {
      if (cloudId) {
        w.ownPairs.push(cloudId);
        if (w.client.gone) throw Object.assign(new Error("Client A is no longer one of your Clouds."), { gone: true });
        if (w.client.down) throw new Error("Cloud request failed.");
        return { origin: CLIENT, code: "CCCC-LLLL-AAAA", expiresAt: w.clock + 60_000 };
      }
      w.pairs++;
      if (w.state?.status !== "connected" || w.cloud.down) throw new Error("My Cloud is not ready to connect yet.");
      return { origin: CLOUD, code: "AAAA-BBBB-CCCC", expiresAt: w.clock + 60_000 };
    },
    async pairTeam(id) {
      w.teamPairs.push(id);
      if (w.team.gone || !(w.state?.teams ?? []).some((team) => team.id === id)) throw Object.assign(new Error("You're no longer in Acme."), { gone: true });
      if (w.state?.status !== "connected" || w.team.down) throw new Error("Cloud request failed.");
      return { origin: TEAM, code: "TTTT-EEEE-AAAA", expiresAt: w.clock + 60_000 };
    },
    signInAgain: async () => { w.signIns.push("again"); },
    begin: async () => { w.signIns.push("begin"); },
    async hideCloud(cloudId) {
      w.hides.push(cloudId);
      if (w.removeAnswer === "removed") w.state = { ...w.state, clouds: (w.state?.clouds ?? []).filter((cloud) => cloud.id !== cloudId) };
      return { outcome: w.removeAnswer };
    },
  };
  w.home = createHomeWindow({
    journal: () => w.journal,
    frozen: async () => w.marker,
    ownMove: () => w.ownMove,
    account: () => account,
    window: () => w.window,
    ensureWindow: () => { w.calls.push("ensure"); },
    localOrigin: () => LOCAL,
    cookieFetch: async (url, init) => {
      const atClient = String(url).startsWith(CLIENT), atTeam = String(url).startsWith(TEAM), server = atClient ? w.client : atTeam ? w.team : w.cloud;
      const base = atClient ? CLIENT : atTeam ? TEAM : CLOUD;
      w.fetched.push([String(url).replace(base, atClient ? "client:" : atTeam ? "team:" : ""), init?.headers?.["x-omb-background"] ?? null]);
      if (server.down) throw new TypeError("fetch failed");
      const route = String(url).replace(base, "");
      if (route === "/api/health") return new Response("", { status: server.health, headers: server.health === 503 ? { "x-omb-cloud-power": "asleep" } : {} });
      if (route === "/api/auth/session") return server.signedIn ? json({ kind: "session", ...(server.expiresAt ? { expiresAt: server.expiresAt } : {}) }) : json({ error: "sign in" }, 401);
      if (route === "/api/auth/pair" && init?.method === "POST") {
        w.redeemed.push([atClient ? "client" : atTeam ? "team" : "cloud", JSON.parse(init.body)]);
        return server.redeems === false ? json({ error: "invalid code" }, 400) : json({ kind: "session" });
      }
      if (route === "/.well-known/openmausbot/environment") return json({ version: server.version });
      return json({}, 404);
    },
    power: { asleep: () => w.power?.state === "asleep", hold: () => { w.power = { state: "asleep", since: 1 }; }, woke: () => w.calls.push("woke") },
    go: async (url, origin, place) => { w.went.push(place?.kind === "team" || place?.kind === "own" ? [url, origin, place.id] : [url, origin]); w.url = url; if (w.stall(url)) await new Promise(() => {}); },
    showLocal: (leaving) => { w.local.push(leaving); if (leaving) w.url = `${LOCAL}/`; },
    remembered: () => w.remembered,
    remember: (place) => { w.remembers.push(place); w.remembered = place ? { ...place, name: ACME.name, origin: TEAM } : null; },
    left: (name) => w.left.push(name),
    drop: (place) => { w.dropped.push(place.id); if (place.kind !== "own") w.left.push(place.name); w.remembered = null; },
    splash: () => (splash ? { status: (text) => w.splash.push(text) } : null),
    lastInput: () => w.typed,
    publish: (view) => w.published.push(view),
    rehomed: (home) => { w.rehomes.push(home); if (w.rehomeThrows) throw new Error("listener broke"); },
    now: w.now,
    timers,
  });
  w.later = async (ms) => {
    w.clock += ms;
    const due = w.timers.filter((timer) => timer.at <= w.clock);
    w.timers = w.timers.filter((timer) => timer.at > w.clock);
    for (const timer of due) timer.work();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  w.tick = async () => { for (const timer of w.intervals) timer.work(); for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
  return w;
}

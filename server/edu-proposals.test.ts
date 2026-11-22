import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { EduProposal } from "../shared/edu-brain.ts";
import type { OptionCardData } from "../shared/wire.ts";
import type { EduRuntime } from "./edu-brain.ts";
import { createEduProposals, decisionOf, EDU_REJECT_REASON, eduCommands, eduDecisionRefusal, parseProposals, type EduRun } from "./edu-proposals.ts";
import type { RequestAuth } from "./request-auth.ts";
import { createEduRoutes } from "./routes/edu.ts";
import { PASS } from "./routes/table.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const root = mkdtempSync(join(tmpdir(), "edu-proposals-"));
afterAll(() => removeTempDir(root));

const CLI = "/opt/edu/dist/cli.js";
const home = join(root, "global");
const folder = join(root, "brains", "bot-1");

function note(dir: string, kind: string, slug: string, body: string): string {
  const file = join(dir, "brain", "1-canonical", kind, `${slug}.md`);
  mkdirSync(join(dir, "brain", "1-canonical", kind), { recursive: true });
  writeFileSync(file, `---\nid: K-${slug}\nstatus: proposed\n---\n\n${body}\n`);
  return file;
}

const ownPath = note(join(folder, ".edu"), "standard", "iso-dates", "Dates as YYYY-MM-DD.");
const globalPath = note(home, "preference", "short-answers", "Short answers.");
const row = (id: string, path: string, extra: object = {}) => ({ id, title: id.slice(2), kind: "standard", source: "mcp", band: "verified", why: "needs human confirmation", path, ...extra });

const loopback: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const service: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };
const session = (admin: boolean): RequestAuth => ({ kind: "session", via: "bearer", scopes: admin ? ["admin", "client"] : ["client"], session: {} as never });

type Bus = { subscribe(listener: (event: { type: string; threadId: string }) => void): () => void };

function setup(options: { listing?: unknown[]; decide?: (args: string[]) => string; env?: NodeJS.ProcessEnv; desktop?: boolean;
  groups?: Array<{ threadId: string; memberIds: string[]; tasks?: Array<{ threadId: string }> }>; others?: Array<{ id: string; folder: string }>; bus?: Bus; gate?: Promise<void> } = {}) {
  const runtime: EduRuntime = { state: "ready", home, cli: CLI, version: "6.0.0" };
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  let listing = options.listing ?? [row("K-iso-dates", ownPath), row("K-short-answers", globalPath)];
  const run: EduRun = async (args, { env }) => {
    calls.push({ args, env });
    if (args.includes("proposals")) {
      await options.gate;
      return { code: 0, stdout: JSON.stringify(listing), stderr: "" };
    }
    return { code: 0, stdout: options.decide?.(args) ?? JSON.stringify({ accepted: [], rejected: [], errors: [] }), stderr: "" };
  };
  const messages = new Map<string, Array<{ id: string; card?: OptionCardData; from?: { botId: string } }>>();
  const decisions: Array<Record<string, unknown>> = [];
  const bot = { id: "bot-1", name: "Luna", color: "blue", threadId: "t-main" };
  const bots = [bot, ...(options.others ?? []).map((other) => ({ id: other.id, name: other.id, color: "red", threadId: `t-${other.id}` }))];
  const folderOf = (id: string) => options.others?.find((other) => other.id === id)?.folder ?? folder;
  let next = 0;
  const store = {
    bots,
    groups: options.groups ?? [],
    bot: (id: string) => bots.find((candidate) => candidate.id === id) ?? null,
    tasks: (botId: string) => (botId === bot.id ? [{ threadId: "t-main" }, { threadId: "t-side" }] : []),
    messagesFor: (threadId: string) => messages.get(threadId) ?? [],
    appendMessage: (threadId: string, message: { card: OptionCardData; from?: { botId: string } }) => {
      const id = `m${++next}`;
      messages.set(threadId, [...(messages.get(threadId) ?? []), { id, card: message.card, ...(message.from ? { from: message.from } : {}) }]);
      return { id };
    },
    patchMessage: (threadId: string, id: string, patch: { card: OptionCardData }) => {
      messages.set(threadId, (messages.get(threadId) ?? []).map((message) => (message.id === id ? { ...message, ...patch } : message)));
    },
  };
  const start = () => createEduProposals({
    brains: {
      detect: async () => runtime,
      brain: async (one) => ({ ok: true, folder: folderOf(one.id), runtime }),
      brainFolder: (one) => folderOf(one.id),
    },
    store,
    inRoom: (threadId) => threadId.startsWith("t-room"),
    decide: (entry) => decisions.push(entry),
    desktop: options.desktop ?? true,
    env: options.env ?? { PATH: "/usr/bin", EDU_CREW_JOB: "" },
    run,
    ...(options.bus ? { bus: options.bus } : {}),
  });
  const proposals = start();
  const cards = (threadId: string) => store.messagesFor(threadId).map((message) => message.card!);
  return { proposals, calls, decisions, store, cards, restart: start, setListing: (next: unknown[]) => { listing = next; } };
}

describe("Edu proposal listing", () => {
  it("keeps this brain's and the global brain's proposals, with their text, and drops anything else", () => {
    const stray = note(join(root, "elsewhere", ".edu"), "domain", "stray", "Not ours.");
    const proposals = parseProposals(JSON.stringify([
      row("K-iso-dates", ownPath), row("K-short-answers", globalPath), row("K-stray", stray), row("--all", ownPath), { title: "no id" },
    ]), folder, home);
    expect(proposals).toEqual([
      expect.objectContaining({ id: "K-iso-dates", global: false, brain: folder, location: folder, body: "Dates as YYYY-MM-DD.", band: "verified" }),
      expect.objectContaining({ id: "K-short-answers", global: true, brain: folder, location: home, body: "Short answers." }),
    ]);
  });

  it("reads Edu's decision for one id, and a proposal decided elsewhere as gone", () => {
    expect(decisionOf(JSON.stringify({ accepted: ["K-a"], rejected: [], errors: [] }), "K-a")).toBe("accepted");
    expect(decisionOf(JSON.stringify({ accepted: [], rejected: ["K-a"], errors: [] }), "K-a")).toBe("rejected");
    expect(decisionOf(JSON.stringify({ accepted: [], rejected: [], errors: [{ id: "K-a", error: "Canonical note not found: K-a" }] }), "K-a")).toBe("gone");
    expect(decisionOf(JSON.stringify({ accepted: [], rejected: [], errors: [{ id: "K-a", error: "Only proposed canonical notes can be accepted" }] }), "K-a")).toBe("gone");
    expect(decisionOf("not json", "K-a")).toEqual({ error: "Edu printed no result" });
  });

  it("builds the exact command lines", () => {
    expect(eduCommands.list(folder)).toEqual(["--cwd", folder, "brain", "proposals", "--json"]);
    expect(eduCommands.approve(folder, "K-a")).toEqual(["--cwd", folder, "brain", "approve", "K-a", "--yes", "--json"]);
    expect(eduCommands.reject(folder, "K-a")).toEqual(["--cwd", folder, "brain", "approve", "--reject", "K-a", "--reason", "Rejected in Edu Bot", "--yes", "--json"]);
    expect(EDU_REJECT_REASON).toBe("Rejected in Edu Bot");
  });
});

describe("Edu proposal cards", () => {
  it("cards each new proposal of the bot's own brain once, after a turn, and never a global one", async () => {
    const { proposals, calls, cards, decisions } = setup();
    await proposals.sweep("t-main", "bot-1", folder);
    await proposals.sweep("t-main", "bot-1", folder);
    expect(calls.map((call) => call.args)).toEqual([[CLI, ...eduCommands.list(folder)], [CLI, ...eduCommands.list(folder)]]);
    expect(calls[0]!.env.EDU_HOME).toBe(home);
    expect(calls[0]!.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect("EDU_CREW_JOB" in calls[0]!.env).toBe(false);
    const posted = cards("t-main");
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ title: "Save to Luna's Edu brain?", options: ["Approve", "Reject"], tool: "edu_propose_canonical",
      eduProposal: { id: "K-iso-dates", global: false, brain: folder } });
    expect(posted[0]!.requestId).toMatch(/^edu-[\w-]+$/);
    expect(posted[0]!.subtitle).toBe("iso-dates\nRule · Verified\n\nDates as YYYY-MM-DD.\n\nLuna's Edu brain");
    expect(decisions).toEqual([expect.objectContaining({ decision: "card-shown", source: "edu-brain", tool: "edu_propose_canonical", botId: "bot-1" })]);
  });

  it("names the bot on a card in a room", async () => {
    const { proposals, store } = setup();
    await proposals.sweep("t-room", "bot-1", folder);
    expect(store.messagesFor("t-room")[0]!.from).toEqual({ botId: "bot-1", name: "Luna", color: "blue" });
  });

  it("a card whose proposal was decided elsewhere becomes unavailable on the next check", async () => {
    const { proposals, cards, setListing } = setup();
    await proposals.sweep("t-main", "bot-1", folder);
    setListing([]);
    await proposals.sweep("t-side", "bot-1", folder);
    expect(cards("t-main")[0]).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(cards("t-side")).toEqual([]);
  });

  it("approves with --yes and no crew-worker guard, then settles the card and logs the person's decision", async () => {
    const { proposals, calls, cards, decisions } = setup({ decide: (args) => JSON.stringify({ accepted: args.includes("K-iso-dates") ? ["K-iso-dates"] : [], rejected: [], errors: [] }) });
    await proposals.sweep("t-main", "bot-1", folder);
    const requestId = cards("t-main")[0]!.requestId!;
    expect(await proposals.resolve("t-main", requestId, "allow")).toEqual({ ok: true, outcome: "allowed-once" });
    expect(calls.at(-1)!.args).toEqual([CLI, "--cwd", folder, "brain", "approve", "K-iso-dates", "--yes", "--json"]);
    expect("EDU_CREW_JOB" in calls.at(-1)!.env).toBe(false);
    expect(cards("t-main")[0]!.answered).toBe("allow");
    expect(decisions.at(-1)).toMatchObject({ decision: "user-approved", source: "user", requestId, botId: "bot-1" });
    expect(await proposals.resolve("t-main", requestId, "deny")).toEqual({ ok: true, outcome: "allowed-once", alreadySettled: true });
  });

  it("rejects with Edu Bot's reason", async () => {
    const { proposals, calls, cards, decisions } = setup({ decide: () => JSON.stringify({ accepted: [], rejected: ["K-iso-dates"], errors: [] }) });
    await proposals.sweep("t-main", "bot-1", folder);
    expect(await proposals.resolve("t-main", cards("t-main")[0]!.requestId!, "deny")).toEqual({ ok: true, outcome: "rejected" });
    expect(calls.at(-1)!.args).toEqual([CLI, "--cwd", folder, "brain", "approve", "--reject", "K-iso-dates", "--reason", "Rejected in Edu Bot", "--yes", "--json"]);
    expect(cards("t-main")[0]!.answered).toBe("deny");
    expect(decisions.at(-1)).toMatchObject({ decision: "user-denied", source: "user" });
  });

  it("a proposal Edu no longer holds leaves its card unavailable", async () => {
    const { proposals, cards } = setup({ decide: () => JSON.stringify({ accepted: [], rejected: [], errors: [{ id: "K-iso-dates", error: "Canonical note not found: K-iso-dates" }] }) });
    await proposals.sweep("t-main", "bot-1", folder);
    expect(await proposals.resolve("t-main", cards("t-main")[0]!.requestId!, "allow")).toEqual({ ok: true, outcome: "unavailable" });
    expect(cards("t-main")[0]).toMatchObject({ answered: "unavailable", dismissed: true });
  });

  it("refuses every decision when Edu Bot itself runs as an Edu crew worker, without running Edu", async () => {
    const { proposals, calls, cards } = setup({ env: { EDU_CREW_JOB: "job-1" } });
    await proposals.sweep("t-main", "bot-1", folder);
    const before = calls.length;
    expect(await proposals.resolve("t-main", cards("t-main")[0]!.requestId!, "allow")).toMatchObject({ ok: false, status: 409 });
    expect(calls).toHaveLength(before);
    expect(cards("t-main")[0]!.answered).toBeUndefined();
  });

  it("returns null for a card that is not an Edu proposal", async () => {
    const { proposals } = setup();
    expect(await proposals.resolve("t-main", "other", "allow")).toBeNull();
    expect(proposals.answerRefusal(service, "t-main", "other", "allow")).toBeUndefined();
  });
});

describe("Edu proposal cards across rooms, restarts, sweeps and turn endings", () => {
  const room = { threadId: "t-room", memberIds: ["bot-1"], tasks: [{ threadId: "t-room-task" }] };

  it("finds a room's card after a restart: no second card, and a decision in settings settles it", async () => {
    const { proposals, restart, cards } = setup({ groups: [room], decide: () => JSON.stringify({ accepted: ["K-iso-dates"], rejected: [], errors: [] }) });
    await proposals.sweep("t-room-task", "bot-1", folder);
    expect(cards("t-room-task")).toHaveLength(1);
    const again = restart();
    await again.sweep("t-main", "bot-1", folder);
    expect(cards("t-main")).toEqual([]);
    expect(await again.decideFor({ id: "bot-1", name: "Luna", color: "blue" }, "K-iso-dates", true)).toEqual({ ok: true, outcome: "allowed-once" });
    expect(cards("t-room-task")[0]!.answered).toBe("allow");
  });

  it("sweeps one brain at a time, so two bots ending turns together card a proposal once", async () => {
    let open = () => {};
    const { proposals, calls, cards } = setup({ gate: new Promise<void>((done) => { open = done; }) });
    const both = Promise.all([proposals.sweep("t-main", "bot-1", folder), proposals.sweep("t-side", "bot-1", folder)]);
    for (let tick = 0; tick < 20; tick += 1) await new Promise((done) => setImmediate(done));
    expect(calls).toHaveLength(1);
    open();
    await both;
    expect(calls).toHaveLength(2);
    expect([...cards("t-main"), ...cards("t-side")]).toHaveLength(1);
  });

  it("checks after a turn however it ends, and forgets a mount the next turn in that thread did not have", async () => {
    let emit: (event: { type: string; threadId: string }) => void = () => {};
    const bus: Bus = { subscribe: (listener) => { emit = listener; return () => {}; } };
    const { proposals, calls, cards } = setup({ bus });
    const settled = async () => { for (let tick = 0; tick < 20; tick += 1) await new Promise((done) => setImmediate(done)); };
    proposals.mounted("t-main", { id: "bot-1" }, folder);
    emit({ type: "turn.completed", threadId: "t-main" });
    await settled();
    expect(cards("t-main")).toHaveLength(1);
    proposals.mounted("t-side", { id: "bot-1" }, folder);
    emit({ type: "session.exited", threadId: "t-side" });
    await settled();
    expect(calls).toHaveLength(2);
    proposals.mounted("t-main", { id: "bot-1" }, folder);
    proposals.mounted("t-main", { id: "bot-1" }, null);
    emit({ type: "turn.completed", threadId: "t-main" });
    await settled();
    expect(calls).toHaveLength(2);
  });

  it("drops a global proposal decided for one bot from every bot's Needs you at once", async () => {
    const other = join(root, "brains", "bot-2");
    mkdirSync(join(other, ".edu"), { recursive: true });
    const { proposals } = setup({ others: [{ id: "bot-2", folder: other }], decide: () => JSON.stringify({ accepted: ["K-short-answers"], rejected: [], errors: [] }) });
    await proposals.view({ id: "bot-1", name: "Luna", color: "blue" }, true);
    await proposals.view({ id: "bot-2", name: "bot-2", color: "red" }, true);
    expect(proposals.needsYou().filter((item) => "proposalId" in item && item.proposalId === "K-short-answers")).toHaveLength(1);
    for (let tick = 0; tick < 20; tick += 1) await new Promise((done) => setImmediate(done));
    await proposals.decideFor({ id: "bot-2", name: "bot-2", color: "red" }, "K-short-answers", true);
    expect(proposals.needsYou().map((item) => "proposalId" in item && item.proposalId)).toEqual(["K-iso-dates"]);
  });
});

describe("Edu proposal answers", () => {
  it("takes only approve or reject: any other answer is refused before Edu runs, and refused to a service", async () => {
    const { proposals, calls, cards } = setup();
    await proposals.sweep("t-main", "bot-1", folder);
    const requestId = cards("t-main")[0]!.requestId!;
    const before = calls.length;
    expect(await proposals.resolve("t-main", requestId, "answer")).toMatchObject({ ok: false, status: 400 });
    expect(calls).toHaveLength(before);
    expect(cards("t-main")[0]!.answered).toBeUndefined();
    expect(proposals.answerRefusal(service, "t-main", requestId, "answer")).toMatch(/can only reject/);
  });

  it("re-checks the id before running Edu, even from a card", async () => {
    const { proposals, calls, store } = setup();
    store.appendMessage("t-main", { card: { title: "x", subtitle: "x", options: [], requestId: "edu-forged", tool: "edu_propose_canonical",
      eduProposal: { id: "--all", title: "x", kind: "", band: "", why: "", brain: folder, global: false, location: folder } } });
    expect(await proposals.resolve("t-main", "edu-forged", "allow")).toMatchObject({ ok: false, status: 400 });
    expect(calls).toEqual([]);
  });

  it("tells each caller what it may decide, by the rule deciding uses", () => {
    expect(setup().proposals.rights(loopback)).toEqual({ mayApprove: true, mayReject: true });
    expect(setup({ desktop: false }).proposals.rights(loopback)).toEqual({ mayApprove: false, mayReject: true });
    expect(setup().proposals.rights(service)).toEqual({ mayApprove: false, mayReject: true });
    expect(setup().proposals.rights(session(false))).toEqual({ mayApprove: false, mayReject: false });
    expect(setup({ env: { EDU_CREW_JOB: "job-1" } }).proposals.rights(loopback)).toEqual({ mayApprove: false, mayReject: false, crewWorker: true });
  });
});

describe("who may decide an Edu proposal", () => {
  it("a loopback service can only reject; a loopback caller approves only as the desktop app; a session needs admin", () => {
    expect(eduDecisionRefusal(service, true, true)).toMatch(/can only reject/);
    expect(eduDecisionRefusal(service, true, false)).toBeNull();
    expect(eduDecisionRefusal(loopback, false, true)).toMatch(/desktop app or from a paired device/);
    expect(eduDecisionRefusal(loopback, false, false)).toBeNull();
    expect(eduDecisionRefusal(loopback, true, true)).toBeNull();
    expect(eduDecisionRefusal(session(true), false, true)).toBeNull();
    expect(eduDecisionRefusal(session(false), false, true)).toMatch(/admin/);
    expect(eduDecisionRefusal(session(false), false, false)).toMatch(/admin/);
  });

  it("applies to the card's answer", async () => {
    const { proposals, cards } = setup();
    await proposals.sweep("t-main", "bot-1", folder);
    const requestId = cards("t-main")[0]!.requestId!;
    expect(proposals.answerRefusal(service, "t-main", requestId, "allow")).toMatch(/can only reject/);
    expect(proposals.answerRefusal(service, "t-main", requestId, "deny")).toBeNull();
  });
});

describe("Edu proposals in settings and Needs you", () => {
  it("lists every pending proposal, decides one from settings and settles its card", async () => {
    const { proposals, cards, calls } = setup({ decide: () => JSON.stringify({ accepted: ["K-short-answers"], rejected: [], errors: [] }) });
    const view = await proposals.view({ id: "bot-1", name: "Luna", color: "blue" }, true);
    expect(view.mayApprove).toBe(true);
    expect(view.proposals.map((proposal: EduProposal) => [proposal.id, proposal.global])).toEqual([["K-iso-dates", false], ["K-short-answers", true]]);
    expect(await proposals.decideFor({ id: "bot-1", name: "Luna", color: "blue" }, "K-short-answers", true)).toEqual({ ok: true, outcome: "allowed-once" });
    expect(calls.at(-1)!.args).toEqual([CLI, ...eduCommands.approve(folder, "K-short-answers")]);
    expect(cards("t-main")).toEqual([]);
  });

  it("answers a proposal that is gone as unavailable and refuses an id that could be a flag", async () => {
    const { proposals, calls } = setup();
    expect(await proposals.decideFor({ id: "bot-1", name: "Luna", color: "blue" }, "K-nope", true)).toEqual({ ok: true, outcome: "unavailable" });
    expect(await proposals.decideFor({ id: "bot-1", name: "Luna", color: "blue" }, "--all", true)).toMatchObject({ ok: false, status: 400 });
    expect(calls.every((call) => !call.args.includes("approve"))).toBe(true);
  });

  it("shows each pending proposal once in Needs you, the global ones marked", async () => {
    const { proposals } = setup();
    await proposals.sweep("t-main", "bot-1", folder);
    expect(proposals.needsYou()).toEqual([
      expect.objectContaining({ kind: "edu-proposal", botId: "bot-1", proposalId: "K-iso-dates", global: false, threadId: "t-main" }),
      expect.objectContaining({ kind: "edu-proposal", botId: "bot-1", proposalId: "K-short-answers", global: true }),
    ]);
  });
});

describe("Edu routes", () => {
  async function call(auth: RequestAuth, method: string, path: string, body?: object, desktop = true) {
    const decide = (args: string[]) => JSON.stringify(args.includes("--reject") ? { accepted: [], rejected: ["K-iso-dates"], errors: [] } : { accepted: ["K-iso-dates"], rejected: [], errors: [] });
    const { proposals } = setup({ decide, desktop });
    const route = createEduRoutes({
      bot: (id) => (id === "bot-1" ? { id, name: "Luna", color: "blue" } : null),
      status: async () => ({ state: "ready", mode: "own", home, brain: folder, version: "6.0.0", cli: CLI }),
      proposals, desktop, crew: { view: async () => ({ enabled: false }), details: () => null, cancelFor: async () => ({ ok: false, status: 404, error: "No such Edu crew job." }) },
    });
    let sent: { status: number; body: unknown } | null = null;
    const out = await route({
      req: {} as never, res: {} as never, url: new URL(`http://localhost${path}`), path, method, auth,
      json: ((_res: unknown, status: number, value: unknown) => { sent = { status, body: value }; }) as never,
      readBody: (async () => body ?? {}) as never,
    });
    return out === PASS ? null : sent as { status: number; body: Record<string, unknown> } | null;
  }

  it("shows the brain and its proposals to the owner, never to a service", async () => {
    const owner = (await call(loopback, "GET", "/api/bots/bot-1/edu"))!;
    expect(owner.status).toBe(200);
    expect(owner.body).toMatchObject({ state: "ready", brain: folder, mayApprove: true });
    expect((owner.body.proposals as unknown[]).length).toBe(2);
    expect(owner.body).not.toHaveProperty("cli");
    expect((await call(service, "GET", "/api/bots/bot-1/edu"))?.status).toBe(403);
  });

  it("refuses a service's approve with 403 and lets it reject", async () => {
    expect(await call(service, "POST", "/api/bots/bot-1/edu/proposals/K-iso-dates", { action: "approve" })).toMatchObject({ status: 403 });
    expect(await call(service, "POST", "/api/bots/bot-1/edu/proposals/K-iso-dates", { action: "reject" })).toMatchObject({ status: 200, body: { outcome: "rejected" } });
  });

  it("approves for a paired admin session, and not for a loopback caller outside the desktop app", async () => {
    expect(await call(session(true), "POST", "/api/bots/bot-1/edu/proposals/K-iso-dates", { action: "approve" }, false)).toMatchObject({ status: 200, body: { outcome: "allowed-once" } });
    expect(await call(loopback, "POST", "/api/bots/bot-1/edu/proposals/K-iso-dates", { action: "approve" }, false)).toMatchObject({ status: 403 });
    expect(await call(session(true), "POST", "/api/bots/bot-1/edu/proposals/K-iso-dates", { action: "keep" })).toMatchObject({ status: 400 });
  });

  it("tells the chat card what this caller may decide", async () => {
    expect(await call(service, "GET", "/api/edu/rights")).toEqual({ status: 200, body: { mayApprove: false, mayReject: true } });
    expect(await call(loopback, "GET", "/api/edu/rights", undefined, false)).toEqual({ status: 200, body: { mayApprove: false, mayReject: true } });
    expect(await call(loopback, "GET", "/api/edu/rights")).toEqual({ status: 200, body: { mayApprove: true, mayReject: true } });
  });

  it("passes other paths", async () => {
    expect(await call(loopback, "GET", "/api/bots/bot-1/memory")).toBeNull();
  });
});

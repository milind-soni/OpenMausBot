// status, bots get|delete|pause|resume|stop, stop, threads and computers. Each change is the request the app makes, so
// the server's own refusals stand: the MausBot bot is never deleted, and a busy bot or conversation answers "busy".
import { EXIT, flag, HeadlessError, usageError } from "./args.ts";
import { explain, type HeadlessClient } from "./client.ts";
import type { VerbContext, VerbOutcome } from "./context.ts";
import { shortId } from "./output.ts";

type Rec = Record<string, any>;

const DELETE_BATCH = 500;

async function readBots(client: HeadlessClient): Promise<Rec[]> {
  const fleet = await client.json<Rec>("/api/bots?messages=0");
  return Array.isArray(fleet.bots) ? fleet.bots : [];
}

const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();

/** The one bot a name or id means; a name two bots share is refused. */
export function findBot(bots: readonly Rec[], wanted: string): Rec {
  const byId = bots.find((bot) => bot.id === wanted);
  if (byId) return byId;
  const named = bots.filter((bot) => lower(bot.name) === lower(wanted));
  if (named.length === 1) return named[0]!;
  if (named.length > 1) {
    throw usageError(`"${wanted}" names ${named.length} bots: ${named.map((bot) => `${bot.name} (id ${bot.id})`).join("; ")}`, "use the id");
  }
  throw new HeadlessError(`no bot named "${wanted}"`, EXIT.notFound, "openmausbot status lists them");
}

export type Selection = { kind: "names"; bots: Rec[] } | { kind: "team"; team: string; bots: Rec[] } | { kind: "all"; bots: Rec[] };

/** Names or ids, `--team NAME` or `--all`: exactly one of them. */
export function selectBots(bots: readonly Rec[], ctx: Pick<VerbContext, "flags" | "positionals" | "verb">, positionals = ctx.positionals): Selection {
  const team = flag(ctx.flags, "team")?.trim();
  const all = ctx.flags.all === true;
  const ways = [positionals.length > 0, team !== undefined, all].filter(Boolean).length;
  if (ways !== 1) {
    throw usageError(ways ? "pick bots one way: names or ids, --team NAME, or --all" : "name the bots",
      `openmausbot ${ctx.verb} NAME…, --team NAME or --all`);
  }
  if (all) return { kind: "all", bots: [...bots] };
  if (team !== undefined) {
    const members = bots.filter((bot) => lower(bot.section) === lower(team));
    if (!members.length) {
      const teams = [...new Set(bots.map((bot) => bot.section).filter(Boolean))];
      throw new HeadlessError(`no bots in a team named "${team}"`, EXIT.notFound, teams.length ? `teams here: ${teams.join(", ")}` : "no bot is in a team");
    }
    return { kind: "team", team: String(members[0]!.section), bots: members };
  }
  const picked = new Map<string, Rec>();
  for (const wanted of positionals) {
    const bot = findBot(bots, wanted.trim());
    picked.set(bot.id, bot);
  }
  return { kind: "names", bots: [...picked.values()] };
}

/** What a person reads in the status list. */
export function botState(bot: Rec, held: ReadonlySet<string> | null): string {
  if (held?.has(bot.id)) return "paused";
  if (bot.activity === "dead" || bot.activity === "no-signal") return "failed";
  if (bot.activity === "waiting-on-you") return "waiting on you";
  if (bot.busy || bot.activity === "working") return "working";
  if (bot.waitingForTeammates) return "waiting on teammates";
  return "idle";
}

export function botComputer(bot: Rec): string {
  if (bot.computer === "off") return "none";
  if (bot.computer === "cloud") return bot.cloudBackend === "vps" ? "cloud (VPS)" : "cloud";
  if (bot.computer === "vm") return "local VM";
  if (bot.computer === "local") return "this computer";
  return bot.computer ?? "auto";
}

function table(rows: readonly string[][]): string[] {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!))).join("  ").trimEnd());
}

async function pausedBots(client: HeadlessClient): Promise<Set<string> | null> {
  const paused = await client.json<Rec>("/api/paused").catch(() => null);
  return Array.isArray(paused?.heldBots) ? new Set(paused.heldBots) : null;
}

async function serverLabel(client: HeadlessClient): Promise<string> {
  const environment = await client.json<Rec>("/.well-known/openmausbot/environment").catch(() => ({} as Rec));
  return `${environment.label ? `"${environment.label}" ` : ""}(${client.baseUrl})`;
}

export async function statusVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const client = await ctx.client();
  const [bots, held, environment, session] = await Promise.all([
    readBots(client), pausedBots(client),
    client.json<Rec>("/.well-known/openmausbot/environment").catch(() => ({} as Rec)),
    client.json<Rec>("/api/auth/session").catch(() => null),
  ]);
  const rows = bots.map((bot) => ({ id: bot.id, name: bot.name, team: bot.section ?? null, state: botState(bot, held), computer: botComputer(bot),
    working: (bot.tasks ?? []).filter((task: Rec) => task.busy).length }));
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
  const who = session?.kind === "session" ? `signed in as "${session.label}"${session.scopes?.includes("admin") ? "" : " (chat only)"}`
    : ctx.botShell ? "as this bot's shell" : "not signed in";
  return {
    result: { server: { url: client.baseUrl, label: environment.label ?? null, version: environment.version ?? null },
      session: session ? { kind: session.kind, ...(session.kind === "session" ? { label: session.label, scopes: session.scopes, expiresAt: session.expiresAt } : { scopes: session.scopes }) } : null,
      botShell: ctx.botShell,
      pausedKnown: held !== null, counts, bots: rows },
    exitCode: EXIT.done,
    human: [
      `${environment.label ?? "MausBot"}${environment.version ? ` · MausBot ${environment.version}` : ""} · ${client.baseUrl} · ${who}`,
      "",
      ...(rows.length
        ? table([["BOT", "STATE", "COMPUTER", "TEAM", "ID"], ...rows.map((row) => [row.name, row.state, row.computer, row.team ?? "—", shortId(row.id)])])
        : ["No bots yet."]),
      "",
      `${rows.length} bot${rows.length === 1 ? "" : "s"}${Object.keys(counts).length ? `: ${Object.entries(counts).map(([state, count]) => `${count} ${state}`).join(" · ")}` : ""}${held === null && rows.length ? " (paused bots show once you sign in with full control)" : ""}`,
    ],
  };
}

interface Step { id: string; name: string; ok: boolean; status?: number; error?: string; hint?: string; exitCode?: number; answer?: unknown }

/** Runs each change in turn and keeps going past a refusal; the exit code is the first refusal's. */
async function eachTarget(ctx: VerbContext, client: HeadlessClient, targets: readonly Rec[], change: (bot: Rec) => Promise<unknown>): Promise<{ steps: Step[]; exitCode: number }> {
  const steps: Step[] = [];
  for (const bot of targets) {
    try {
      steps.push({ id: bot.id, name: bot.name, ok: true, answer: await change(bot) });
    } catch (error) {
      const reported = await explain(error, client.baseUrl, { botShell: ctx.botShell, identity: client.identity });
      steps.push({ id: bot.id, name: bot.name, ok: false, error: reported.message, exitCode: reported.exitCode, ...(reported.hint ? { hint: reported.hint } : {}),
        ...(typeof (error as { status?: unknown }).status === "number" ? { status: (error as { status: number }).status } : {}) });
    }
  }
  return { steps, exitCode: steps.find((step) => !step.ok)?.exitCode ?? EXIT.done };
}

const stepLines = (steps: readonly Step[], done: string) => {
  const hint = steps.find((step) => step.hint)?.hint;
  return [...steps.map((step) => `  ${step.ok ? "✓" : "✗"} ${step.name} (${shortId(step.id)})${step.ok ? ` ${done}` : `: ${step.error}`}`), ...(hint ? [`hint: ${hint}`] : [])];
};

/** Prints what a destructive verb would touch; with --dry-run that is the answer. Without --yes it asks, and only a
 * person at a terminal can say yes: a script without --yes stops here. */
async function confirmPlan(ctx: VerbContext, client: HeadlessClient, plan: { doing: string; note: string; lines: string[]; result: Rec }): Promise<VerbOutcome | null> {
  const where = await serverLabel(client);
  const header = `${plan.doing} on ${where}, ${plan.note}:`;
  if (ctx.flags["dry-run"] === true) {
    return { result: { ok: true, dryRun: true, server: client.baseUrl, ...plan.result }, exitCode: EXIT.done, human: [`Would ${header.charAt(0).toLowerCase()}${header.slice(1)}`, ...plan.lines, "Nothing was changed (--dry-run)."] };
  }
  if (!client.explicit) {
    throw usageError("this deletes or stops things, so name the server it is for", "sign in with openmausbot login, or pass --url or --port");
  }
  if (ctx.flags.yes === true) return null;
  if (!ctx.interactive) throw usageError(`this would ${plan.doing.charAt(0).toLowerCase()}${plan.doing.slice(1)} on ${where}: add --yes to go ahead`, "or --dry-run to only see the list");
  ctx.io.err([header, ...plan.lines].join("\n"));
  if (await ctx.confirm("Go ahead?")) return null;
  return { result: { ok: false, cancelled: true }, exitCode: EXIT.failed, human: ["Nothing was changed."] };
}

const botLine = (bot: Rec) => `  ${bot.name} (${shortId(bot.id)})${bot.section ? `, team ${bot.section}` : ""}`;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

async function deleteBots(ctx: VerbContext, client: HeadlessClient, selection: Selection): Promise<VerbOutcome> {
  const kept = selection.bots.filter((bot) => bot.defaultBot);
  const targets = selection.bots.filter((bot) => !bot.defaultBot);
  const keptLines = kept.map((bot) => `  (${bot.name} is kept: the MausBot bot is never deleted)`);
  if (!targets.length) throw new HeadlessError(`${kept.map((bot) => bot.name).join(", ")} is never deleted`, EXIT.conflict, "it can be hidden in Settings → General instead");
  const stop = await confirmPlan(ctx, client, { doing: `Delete ${plural(targets.length, "bot")}`, note: "with their conversations and files", lines: [...targets.map(botLine), ...keptLines],
    result: { action: "delete", bots: targets.map((bot) => ({ id: bot.id, name: bot.name, team: bot.section ?? null })) } });
  if (stop) return stop;
  const { steps, exitCode } = await eachTarget(ctx, client, targets, (bot) => client.json(`/api/bots/${encodeURIComponent(bot.id)}`, { method: "DELETE" }));
  const deleted = steps.filter((step) => step.ok).length;
  return {
    result: { ok: exitCode === EXIT.done, action: "delete", deleted, results: steps.map(({ answer: _answer, ...step }) => step) }, exitCode,
    human: [`Deleted ${deleted} of ${plural(targets.length, "bot")}.`, ...stepLines(steps, "deleted")],
  };
}

async function pauseBots(ctx: VerbContext, client: HeadlessClient, selection: Selection, paused: boolean): Promise<VerbOutcome> {
  const verb = paused ? "pause" : "resume";
  const bodies = selection.kind === "all" ? [{ kind: "all", paused }]
    : selection.kind === "team" ? [{ kind: "department", id: selection.team, paused }]
    : selection.bots.map((bot) => ({ kind: "bot", id: bot.id, paused }));
  const what = selection.kind === "all" ? "every bot, the ones made later too" : selection.kind === "team" ? `the ${selection.team} team, its bots made later too` : selection.bots.map((bot) => bot.name).join(", ");
  if (ctx.flags["dry-run"] === true) {
    return { result: { ok: true, dryRun: true, action: verb, requests: bodies }, exitCode: EXIT.done, human: [`Would ${verb} ${what}. Nothing was changed (--dry-run).`] };
  }
  let stopped = 0;
  for (const body of bodies) stopped += Number((await client.json<Rec>("/api/paused", { method: "POST", body: JSON.stringify(body) })).stopped) || 0;
  return {
    result: { ok: true, action: verb, requests: bodies, stopped },
    exitCode: EXIT.done,
    human: paused
      ? [`Paused ${what}${stopped ? `, and stopped ${plural(stopped, "conversation")} that ${stopped === 1 ? "was" : "were"} working` : ""}. A pause lasts across restarts: openmausbot bots resume ${selection.kind === "all" ? "--all" : selection.kind === "team" ? `--team "${selection.team}"` : "NAME"} undoes it.`]
      : [`Resumed ${what}. A bot or team paused on its own stays paused.`],
  };
}

async function stopBots(ctx: VerbContext, client: HeadlessClient, selection: Selection): Promise<VerbOutcome> {
  const body = selection.kind === "all" ? { all: true } : { botIds: selection.bots.map((bot) => bot.id) };
  if (selection.kind === "all") {
    const working = selection.bots.filter((bot) => bot.busy || bot.activity === "working");
    const stop = await confirmPlan(ctx, client, { doing: "Stop the work of every bot", note: `${working.length} working now, nothing is paused`,
      lines: working.length ? working.map(botLine) : ["  (none is working right now)"], result: { action: "stop", all: true, working: working.map((bot) => ({ id: bot.id, name: bot.name })) } });
    if (stop) return stop;
  } else if (ctx.flags["dry-run"] === true) {
    return { result: { ok: true, dryRun: true, action: "stop", bots: selection.bots.map((bot) => ({ id: bot.id, name: bot.name })) }, exitCode: EXIT.done,
      human: [`Would stop the work of ${selection.bots.map((bot) => bot.name).join(", ")}. Nothing was changed (--dry-run).`] };
  }
  const answer = await client.json<Rec>("/api/turns/stop", { method: "POST", body: JSON.stringify(body) });
  const stopped = Number(answer.stopped) || 0;
  return {
    result: { ok: true, action: "stop", botIds: answer.botIds ?? [], stopped },
    exitCode: EXIT.done,
    human: [`Stopped ${plural(stopped, "conversation")}. Nothing is paused: a new message or routine starts a bot again.`],
  };
}

export async function botsVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const client = await ctx.client();
  const bots = await readBots(client);
  if (ctx.verb === "bots get") {
    const wanted = ctx.positionals[0]?.trim();
    if (!wanted) throw usageError("name a bot", "openmausbot bots get NAME");
    const bot = findBot(bots, wanted);
    const held = await pausedBots(client);
    const tasks: Rec[] = bot.tasks ?? [];
    return {
      result: { ...bot, state: botState(bot, held) },
      exitCode: EXIT.done,
      human: [
        `${bot.name}${bot.title ? ` — ${bot.title}` : ""}`,
        `  id          ${bot.id}`,
        `  team        ${bot.section ?? "—"}`,
        `  state       ${botState(bot, held)}`,
        `  computer    ${botComputer(bot)}`,
        `  model       ${bot.modelSelection?.instanceId ?? "?"}${bot.modelSelection?.model ? `/${bot.modelSelection.model}` : ""}`,
        `  approvals   ${bot.approvalMode ?? (bot.autoApprove ? "auto" : "ask")}`,
        `  threads     ${tasks.length}${tasks.some((task) => task.busy) ? ` (${tasks.filter((task) => task.busy).length} working)` : ""}`,
      ],
    };
  }
  const selection = selectBots(bots, ctx);
  if (ctx.verb === "bots delete") return deleteBots(ctx, client, selection);
  if (ctx.verb === "bots pause" || ctx.verb === "bots resume") return pauseBots(ctx, client, selection, ctx.verb === "bots pause");
  return stopBots(ctx, client, selection);
}

export async function stopVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const client = await ctx.client();
  return stopBots(ctx, client, selectBots(await readBots(client), ctx));
}

async function deleteThreads(ctx: VerbContext, client: HeadlessClient, bot: Rec, threads: readonly Rec[], clearing: boolean): Promise<VerbOutcome> {
  const lines = threads.map((task) => `  ${task.title || "Untitled"} (${shortId(task.threadId)})${task.busy ? ", working now" : ""}`);
  const stop = await confirmPlan(ctx, client, {
    doing: `Delete ${plural(threads.length, "conversation")} of ${bot.name}`, note: clearing ? "and it starts one new, empty conversation" : "for good", lines,
    result: { action: clearing ? "clear" : "delete", bot: { id: bot.id, name: bot.name }, threads: threads.map((task) => ({ id: task.threadId, title: task.title })) },
  });
  if (stop) return stop;
  const deleted: string[] = [];
  const refused: Rec[] = [];
  const ids = threads.map((task) => task.threadId as string);
  for (let at = 0; at < ids.length; at += DELETE_BATCH) {
    const answer = await client.json<Rec>(`/api/bots/${encodeURIComponent(bot.id)}/tasks/delete`, { method: "POST", body: JSON.stringify({ threadIds: ids.slice(at, at + DELETE_BATCH) }) });
    deleted.push(...(answer.deleted ?? []));
    refused.push(...(answer.refused ?? []));
  }
  const busy = refused.filter((refusal) => refusal.reason === "busy").length;
  return {
    result: { ok: refused.length === 0, action: clearing ? "clear" : "delete", bot: { id: bot.id, name: bot.name }, deleted, refused },
    exitCode: refused.length === 0 ? EXIT.done : busy ? EXIT.conflict : EXIT.notFound,
    human: [
      `Deleted ${plural(deleted.length, "conversation")} of ${bot.name}.`,
      ...(refused.length ? [`Kept ${refused.length}: ${busy ? `${busy} working now (stop it first: openmausbot stop "${bot.name}")` : ""}${refused.length - busy ? `${busy ? "; " : ""}${refused.length - busy} not found` : ""}.`] : []),
    ],
  };
}

export async function threadsVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const [wanted, ...threadIds] = ctx.positionals.map((value) => value.trim());
  if (!wanted) throw usageError("name a bot", `openmausbot ${ctx.verb} BOT${ctx.verb === "threads delete" ? " THREAD…" : ""}`);
  const client = await ctx.client();
  const bot = findBot(await readBots(client), wanted);
  const tasks: Rec[] = bot.tasks ?? [];
  if (ctx.verb === "threads list") {
    return {
      result: { bot: { id: bot.id, name: bot.name }, threads: tasks.map((task) => ({ id: task.threadId, title: task.title ?? null, busy: Boolean(task.busy), active: task.threadId === bot.threadId, createdAt: task.createdAt ?? null })) },
      exitCode: EXIT.done,
      human: tasks.length
        ? table([["THREAD", "TITLE", "STATE"], ...tasks.map((task) => [task.threadId, `${task.threadId === bot.threadId ? "* " : ""}${task.title || "Untitled"}`, task.busy ? "working" : "idle"])])
        : [`${bot.name} has no conversations.`],
    };
  }
  if (ctx.verb === "threads clear") {
    if (threadIds.length) throw usageError("threads clear takes only the bot", "threads delete BOT THREAD… deletes some");
    if (!tasks.length) return { result: { ok: true, deleted: [] }, exitCode: EXIT.done, human: [`${bot.name} has no conversations.`] };
    return deleteThreads(ctx, client, bot, tasks, true);
  }
  if (!threadIds.length) throw usageError("name the conversations to delete", "openmausbot threads list BOT shows their ids");
  const picked = threadIds.map((id) => {
    const task = tasks.find((candidate) => candidate.threadId === id);
    if (!task) throw new HeadlessError(`${bot.name} has no conversation ${id}`, EXIT.notFound, `openmausbot threads list "${bot.name}" shows them`);
    return task;
  });
  return deleteThreads(ctx, client, bot, [...new Map(picked.map((task) => [task.threadId, task])).values()], false);
}

async function computerChange(client: HeadlessClient, botId: string, action: "provision" | "sleep"): Promise<Rec> {
  const response = await client.raw(`/api/bots/${encodeURIComponent(botId)}/computer/${action}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}", stream: true,
  });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`OpenMausBot API error (${response.status}): ${text}`), { status: response.status });
  try {
    return JSON.parse(text) as Rec;
  } catch {
    return {};
  }
}

export async function computersVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const client = await ctx.client();
  const bots = await readBots(client);
  if (ctx.verb === "computers list") {
    const inventory = await client.json<Rec>("/api/computers/boxes").catch(() => null);
    const boxes = new Map<string, Rec>((inventory?.instances ?? []).filter((box: Rec) => box.ownerBotId).map((box: Rec) => [box.ownerBotId as string, box]));
    const rows = bots.map((bot) => ({ id: bot.id, name: bot.name, computer: botComputer(bot), cloud: boxes.get(bot.id) ? { state: boxes.get(bot.id)!.state, name: boxes.get(bot.id)!.name } : null }));
    return {
      result: { bots: rows, cloudKnown: inventory !== null },
      exitCode: EXIT.done,
      human: rows.length
        ? table([["BOT", "WORKS ON", "CLOUD COMPUTER"], ...rows.map((row) => [row.name, row.computer, row.cloud ? row.cloud.state : row.computer.startsWith("cloud") ? (inventory ? "none yet" : "?") : "—"])])
        : ["No bots yet."],
    };
  }
  const wanted = ctx.positionals[0]?.trim();
  if (!wanted) throw usageError("name a bot", `openmausbot ${ctx.verb} BOT`);
  const bot = findBot(bots, wanted);
  const starting = ctx.verb === "computers start";
  if (ctx.flags["dry-run"] === true) {
    return { result: { ok: true, dryRun: true, action: starting ? "start" : "sleep", bot: { id: bot.id, name: bot.name } }, exitCode: EXIT.done,
      human: [`Would ${starting ? "start (or wake)" : "put to sleep"} ${bot.name}'s cloud computer. Nothing was changed (--dry-run).`] };
  }
  if (bot.computer !== "cloud") {
    throw new HeadlessError(`${bot.name} works on ${botComputer(bot)}, not a cloud computer`, EXIT.conflict, "choose Cloud computer in the bot's settings first");
  }
  if (starting) ctx.io.err(`Starting ${bot.name}'s cloud computer; a new one takes a few minutes…`);
  const answer = await computerChange(client, bot.id, starting ? "provision" : "sleep");
  return {
    result: { ok: true, action: starting ? "start" : "sleep", bot: { id: bot.id, name: bot.name }, computer: answer },
    exitCode: EXIT.done,
    human: [starting ? `${bot.name}'s cloud computer is ready.` : `${bot.name}'s cloud computer is asleep; it wakes when the bot needs it.`],
  };
}

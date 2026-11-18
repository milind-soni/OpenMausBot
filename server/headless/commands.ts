// `--json` prints a tool's result unchanged; plain output is a line per item.
import { EXIT, flag, parseCount, parseDuration, requiredFlag, usageError } from "./args.ts";
import { conversationFor, conversationTitle, newSendId, readMessage, resolveTarget, type Target, type VerbContext, type VerbOutcome } from "./context.ts";
import { oneLine, shortId } from "./output.ts";
import { stopConversation } from "./run.ts";

type Rec = Record<string, any>;

const dryRun = (ctx: VerbContext, tool: string, args: Rec, extra: Rec = {}): VerbOutcome | undefined =>
  ctx.flags["dry-run"] === true
    ? { result: { ok: true, dryRun: true, command: ctx.verb, tool, arguments: args, ...extra }, exitCode: EXIT.done,
      human: [`Would ${extra.newConversation ? `start a new conversation, "${extra.newConversation.title}", then ` : ""}call ${tool} with ${JSON.stringify(args)}${extra.tree ? ", then stop every teammate still working on it" : ""}. Nothing was sent.`] }
    : undefined;

const targetArgs = (target: Target): Rec => ({ [`${target.type}_id`]: target.id, ...(target.taskId ? { task_id: target.taskId } : {}) });

const DAY = 24 * 3_600_000;

async function doctorOnce(ctx: VerbContext): Promise<VerbOutcome> {
  const client = await ctx.client();
  // A shared server lets a local caller without a session count its engines, not list them: in the server's container
  // (`docker compose exec omb openmausbot doctor`, as deploy/update.sh runs it) that count is the answer.
  const counted = (refusal: unknown) => (refusal as { status?: unknown })?.status === 403
    ? client.json<Rec>("/api/health/engines").then((answer) => ({ counted: Number(answer?.engines) || 0 }), () => Promise.reject(refusal))
    : Promise.reject(refusal);
  const [rawHealth, models] = await Promise.all([client.tool("get_system_health", {}), client.tool("list_available_models", {}).catch(counted)]);
  const health = { ...rawHealth, endpoint: client.baseUrl };
  const instances: Rec[] = Array.isArray(models?.instances) ? models.instances : [];
  const availableEngines = instances.filter((instance) => instance.snapshot?.state === "available").map((instance) => instance.instanceId);
  const availableCount = typeof models?.counted === "number" ? models.counted : availableEngines.length;
  const quietly = <T>(read: Promise<T>) => read.catch(() => null);
  const [server, session, config] = await Promise.all([
    quietly(client.json<Rec>("/.well-known/openmausbot/environment")),
    quietly(client.json<Rec>("/api/auth/session")),
    quietly(client.json<Rec>("/api/config")),
  ]);
  const problems: string[] = [];
  const warnings: string[] = [];
  const isOmb = health.app === "openmausbot";
  if (!isOmb) problems.push(`${client.baseUrl} answered, but it is not OpenMausBot`);
  const tooOld = Boolean(server) && server!.capabilities?.jobs !== true;
  if (tooOld) problems.push(`OpenMausBot ${server!.version ?? "(unknown version)"} is too old for the headless commands: it cannot report a conversation's job`);
  if (isOmb && !availableCount) problems.push("no engine is available: set one up with `openmausbot engine set KIND --key-env VAR`");
  if (session?.kind === "session" && typeof session.expiresAt === "number" && session.expiresAt - Date.now() < 14 * DAY) {
    warnings.push(`this session expires in ${Math.max(0, Math.floor((session.expiresAt - Date.now()) / DAY))} days: get a new one with openmausbot connect`);
  }
  const browser = config?.browserEngine ?? null;
  if (browser && browser.kind !== "engine") warnings.push(`bots have no built-in browser here: ${browser.reason ?? "not installed"}${browser.installable ? " (install it with `openmausbot browser install`)" : ""}`);
  const ok = isOmb && !tooOld && availableCount > 0;
  const who = !session ? "unknown" : session.kind === "loopback"
    ? `this computer${session.trust === "service" ? " (as a local service, not the owner)" : " (the owner)"}`
    : `session "${session.label || "unnamed"}" with ${Array.isArray(session.scopes) && session.scopes.includes("admin") ? "full access" : "chat access"}${typeof session.expiresAt === "number" ? `, until ${new Date(session.expiresAt).toISOString().slice(0, 10)}` : ""}`;
  return {
    result: {
      ok, health, availableEngines, availableEngineCount: availableCount, instances,
      server: server ? { version: server.version, label: server.label, environmentId: server.environmentId, capabilities: server.capabilities } : null,
      session: session ? { kind: session.kind, ...(session.label !== undefined ? { label: session.label } : {}), scopes: session.scopes,
        ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}), ...(session.trust ? { trust: session.trust } : {}) } : null,
      browser, problems, warnings,
    },
    exitCode: ok ? EXIT.done : isOmb && !tooOld ? EXIT.failed : EXIT.unreachable,
    human: [
      `${server ? `OpenMausBot ${server.version} ("${server.label}")` : "OpenMausBot"} at ${client.baseUrl}: ${ok ? "ready" : "not ready"}`,
      `You are: ${who}`,
      `Engines available: ${availableEngines.length ? availableEngines.join(", ") : availableCount ? `${availableCount} (which ones needs a session)` : "none"}`,
      ...(browser ? [`Bots' browser: ${browser.kind === "engine" ? `installed${browser.version ? ` (${browser.version})` : ""}` : "not available"}`] : []),
      ...problems.map((line) => `problem: ${line}`),
      ...warnings.map((line) => `warning: ${line}`),
    ],
  };
}

export async function doctor(ctx: VerbContext): Promise<VerbOutcome> {
  if (ctx.flags.host === true) {
    if (flag(ctx.flags, "wait") !== undefined || flag(ctx.flags, "url") !== undefined) throw usageError("doctor --host checks this machine: drop --wait and --url");
    return (await import("./host-doctor.ts")).hostDoctor(ctx);
  }
  if (flag(ctx.flags, "data-dir") !== undefined || flag(ctx.flags, "domain") !== undefined) throw usageError("--data-dir and --domain go with doctor --host");
  const raw = flag(ctx.flags, "wait");
  const deadline = Date.now() + (raw ? parseDuration(raw, "--wait") : 0);
  for (;;) {
    let outcome: VerbOutcome;
    try {
      outcome = await doctorOnce(ctx);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      outcome = { result: { ok: false }, exitCode: EXIT.unreachable, human: [] };
    }
    if (outcome.exitCode === EXIT.done || Date.now() >= deadline) return outcome;
    ctx.output.progress({ event: "doctor", ready: false, problems: (outcome.result as Rec).problems ?? ["the server did not answer"] });
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, Math.max(0, deadline - Date.now()))));
  }
}

export async function list(ctx: VerbContext): Promise<VerbOutcome> {
  const tool = ctx.verb === "bots" ? "list_bots" : ctx.verb === "channels" ? "list_channels" : "list_available_models";
  const result = await (await ctx.client()).tool(tool, {});
  const human = ctx.verb === "bots"
    ? (result.bots as Rec[]).map((bot) => `${bot.name}${bot.title ? ` — ${bot.title}` : ""} · ${bot.section ? `team ${bot.section}` : "no team"}${bot.chiefOfStaff ? " · Chief of Staff" : ""} · ${bot.activity === "waiting-on-you" ? "waiting on you" : bot.busy ? "working" : bot.waitingForTeammates ? "waiting on teammates" : "idle"} · id ${bot.id}`)
    : ctx.verb === "channels"
      ? (result.channels as Rec[]).map((room) => `${room.name} · ${room.memberIds?.length ?? 0} members · ${room.working ? "working" : "idle"} · id ${room.id}`)
      : (result.instances as Rec[]).map((instance) => `${instance.instanceId} · ${instance.snapshot?.state ?? "unknown"}${instance.models?.default ? ` · default ${instance.models.default}` : ""}${Array.isArray(instance.models?.options) ? ` · ${instance.models.options.length} models` : ""}`);
  return { result, exitCode: EXIT.done, human: human.length ? human : [`No ${ctx.verb === "models" ? "engines" : ctx.verb} yet.`] };
}

export async function messages(ctx: VerbContext): Promise<VerbOutcome> {
  const target = await resolveTarget(ctx, ctx.positionals[0]);
  const limit = parseCount(flag(ctx.flags, "limit"), "--limit", 30, 200);
  const result = await (await ctx.client()).tool(target.type === "bot" ? "get_bot_messages" : "get_channel_messages", { ...targetArgs(target), limit });
  const human = (result.messages as Rec[] ?? []).map((message) => {
    const who = message.role === "user" ? "you" : message.from?.name ?? target.name ?? "bot";
    const what = message.kind === "text" ? oneLine(message.text ?? "", 400)
      : message.kind === "activity" ? `[${message.tool?.name ?? "activity"}${message.tool?.ok === false ? ", failed" : ""}]`
      : message.card ? `[card: ${message.card.title}${message.card.answered ? ` — ${message.card.answered}` : ""}]` : `[${message.kind}]`;
    return `${who}: ${what}`;
  });
  return { result, exitCode: EXIT.done, human: human.length ? human : ["No messages yet."] };
}

export async function send(ctx: VerbContext): Promise<VerbOutcome> {
  const channelOnly = ctx.verb === "send-channel";
  const named = Boolean(flag(ctx.flags, "bot") ?? flag(ctx.flags, "channel") ?? flag(ctx.flags, "thread"));
  const [first, second] = ctx.positionals;
  const text = await readMessage(ctx, named ? first : second);
  const task = flag(ctx.flags, "task")?.trim();
  const opened = task === "new" || task === "current" ? task : undefined;
  if (flag(ctx.flags, "title") !== undefined && opened !== "new") throw usageError("--title names a new conversation: add --task new");
  const target = await resolveTarget(opened ? { ...ctx, flags: { ...ctx.flags, task: undefined } } : ctx, named ? undefined : first, channelOnly ? "channel" : "any");
  const tool = target.type === "bot" ? "send_bot_message" : "send_channel_message";
  const title = opened === "new" && !target.taskId ? conversationTitle(ctx, text) : undefined;
  const current = opened === "current" && !target.taskId ? await conversationFor(await ctx.client(), target, "current") : undefined;
  const args = { ...targetArgs(current ? { ...target, taskId: current } : target), text, send_id: flag(ctx.flags, "send-id") ?? newSendId() };
  const preview = dryRun(ctx, tool, args, title !== undefined ? { newConversation: { title } } : {});
  if (preview) return preview;
  const client = await ctx.client();
  const result = await client.tool(tool, title !== undefined ? { ...args, task_id: await conversationFor(client, target, "new", title) } : args);
  return {
    result: title !== undefined ? { ...result, newConversation: { title } } : result, exitCode: EXIT.done,
    human: [`Sent to ${target.name ?? target.id} ${title !== undefined ? `in a new conversation, "${title}", ` : ""}(thread ${result.taskId})${result.queued ? "; it waits until the turn running there ends" : ""}.`,
      `Follow it with: openmausbot wait --thread ${result.taskId}`],
  };
}

export async function interrupt(ctx: VerbContext): Promise<VerbOutcome> {
  const tree = ctx.flags.tree === true;
  const target = await resolveTarget(ctx, ctx.positionals[0]);
  const args = interruptArgs(target);
  const preview = dryRun(ctx, "interrupt_conversation", args, tree ? { tree } : {});
  if (preview) return preview;
  const { result, stopped } = await stopConversation(await ctx.client(), target, tree);
  return {
    result: tree ? { ...result, teammates: stopped } : result, exitCode: EXIT.done,
    human: [`Stopped ${target.name ?? target.id}'s turn in thread ${result.taskId}.`,
      ...(tree ? [stopped.length ? `Also stopped ${stopped.length} teammate task${stopped.length === 1 ? "" : "s"}: ${stopped.map((node) => node.botName).join(", ")}.` : "No teammate was still working on it."] : [])],
  };
}

const interruptArgs = (target: Target): Rec => ({ target_type: target.type, target_id: target.id, ...(target.taskId ? { task_id: target.taskId } : {}) });

function modelArgs(ctx: VerbContext, required: boolean): Rec {
  const model = flag(ctx.flags, "model")?.trim();
  const instance = flag(ctx.flags, "instance")?.trim();
  const effort = flag(ctx.flags, "effort")?.trim();
  if (!model) {
    if (instance || effort || required) throw usageError("--model is required (INSTANCE/MODEL, such as claude/claude-sonnet-5-5)", "openmausbot models lists them");
    return {};
  }
  let instanceId = instance;
  let modelId = model;
  if (!instanceId) {
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) throw usageError("--model must be INSTANCE/MODEL, such as claude/claude-sonnet-5-5", "openmausbot models lists them");
    instanceId = model.slice(0, slash);
    modelId = model.slice(slash + 1);
  }
  return { instance_id: instanceId, model: modelId, ...(effort ? { effort } : {}) };
}

export async function newBot(ctx: VerbContext): Promise<VerbOutcome> {
  const name = (flag(ctx.flags, "name") ?? ctx.positionals[0])?.trim();
  if (!name) throw usageError("--name is required (the new bot's name)");
  const team = (flag(ctx.flags, "team") ?? flag(ctx.flags, "section"))?.trim();
  const title = flag(ctx.flags, "title");
  const result = await (await ctx.client()).tool("create_bot", { name, ...(title ? { title } : {}), ...(team ? { section: team } : {}), ...modelArgs(ctx, false) });
  return { result, exitCode: EXIT.done, human: [`Created ${result.bot.name}${team ? ` in team ${team}` : ""} (id ${result.bot.id}).`] };
}

export async function newChannel(ctx: VerbContext): Promise<VerbOutcome> {
  const name = (flag(ctx.flags, "name") ?? ctx.positionals[0])?.trim();
  if (!name) throw usageError("--name is required (the new room's name)");
  const wanted = requiredFlag(ctx.flags, "members").split(",").map((member) => member.trim()).filter(Boolean);
  if (!wanted.length || new Set(wanted).size !== wanted.length) throw usageError("--members must contain unique comma-separated bot names or ids");
  const client = await ctx.client();
  const bots: Rec[] = (await client.json<Rec>("/api/bots?messages=0")).bots ?? [];
  const memberIds = wanted.map((member) => {
    const found = bots.filter((bot) => bot.id === member);
    const byName = found.length ? found : bots.filter((bot) => String(bot.name).trim().toLowerCase() === member.toLowerCase());
    if (byName.length !== 1) throw usageError(byName.length ? `"${member}" names ${byName.length} bots: use their ids` : `no bot named "${member}"`, "openmausbot bots lists them");
    return byName[0]!.id as string;
  });
  const team = (flag(ctx.flags, "team") ?? flag(ctx.flags, "section"))?.trim();
  const result = await client.tool("create_channel", { name, member_ids: memberIds, ...(team ? { section: team } : {}) });
  return { result, exitCode: EXIT.done, human: [`Created room ${result.channel.name} with ${memberIds.length} members (id ${result.channel.id}).`] };
}

export async function setModel(ctx: VerbContext): Promise<VerbOutcome> {
  const selection = modelArgs(ctx, true);
  const explicit = flag(ctx.flags, "bot")?.trim();
  const target = explicit ? { type: "bot" as const, id: explicit, ...(flag(ctx.flags, "task") ? { taskId: flag(ctx.flags, "task")!.trim() } : {}) }
    : await resolveTarget(ctx, ctx.positionals[0], "bot");
  const args = { bot_id: target.id, ...(target.taskId ? { task_id: target.taskId } : {}), ...selection };
  const preview = dryRun(ctx, "set_bot_model", args);
  if (preview) return preview;
  const result = await (await ctx.client()).tool("set_bot_model", args);
  return { result, exitCode: EXIT.done, human: [`${target.name ?? target.id} now runs on ${selection.instance_id}/${selection.model}${target.taskId ? ` in thread ${shortId(target.taskId)}` : ""}.`] };
}

export async function edit(ctx: VerbContext): Promise<VerbOutcome> {
  const explicit = flag(ctx.flags, "bot")?.trim();
  const [first, second] = ctx.positionals;
  const target: Target | undefined = explicit ? { type: "bot", id: explicit, ...(flag(ctx.flags, "task") ? { taskId: flag(ctx.flags, "task")!.trim() } : {}) } : undefined;
  if (!target && !first) throw usageError("a bot is required", "openmausbot edit BOT --message ID TEXT, or --bot ID");
  const messageId = requiredFlag(ctx.flags, "message");
  const text = await readMessage(ctx, target ? first : second);
  const resolved = target ?? await resolveTarget(ctx, first, "bot");
  const args = { bot_id: resolved.id, message_id: messageId, text, ...(resolved.taskId ? { task_id: resolved.taskId } : {}) };
  const preview = dryRun(ctx, "edit_bot_message", args);
  if (preview) return preview;
  const result = await (await ctx.client()).tool("edit_bot_message", args);
  return { result, exitCode: EXIT.done, human: [`Edited the message and asked ${resolved.name ?? resolved.id} again.`] };
}

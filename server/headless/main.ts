import { HEADLESS_USAGE } from "../cli-usage.ts";
import { EXIT, HeadlessError, MUTATING_VERBS, parseCommand } from "./args.ts";
import { explain, loadMcp, openClient, type ClientDeps, type HeadlessClient } from "./client.ts";
import { doctor, edit, interrupt, list, messages, newBot, newChannel, send, setModel } from "./commands.ts";
import { connectVerb } from "./connect.ts";
import type { VerbContext, VerbOutcome } from "./context.ts";
import { engineVerb } from "./engine.ts";
import { eventsVerb } from "./events.ts";
import { exportVerb } from "./export.ts";
import { Output, processIo, type HeadlessIo } from "./output.ts";
import { runVerb, waitVerb } from "./run.ts";
import { teamApplyVerb, teamExportVerb } from "./team-apply.ts";

const T = "TARGET is a bot or room by name or id, or --bot ID, --channel ID, --thread ID; --task ID picks one of its conversations.";

/** Each verb's help, in plain words. `openmausbot help VERB` or `VERB --help`. */
export const VERB_HELP: Record<string, string> = {
  doctor: `openmausbot doctor [--wait DURATION]
  Check the server answers, is new enough, says who you are to it, and has an engine ready.
  --wait 2m keeps checking until it is ready. Exit 0 ready, 1 no engine, 5 unreachable or too old.`,
  bots: "openmausbot bots\n  Your bots and what each is doing.",
  channels: "openmausbot channels\n  Your rooms (group chats) and who is in them.",
  models: "openmausbot models\n  The engines and the models each offers (use them as INSTANCE/MODEL).",
  messages: `openmausbot messages TARGET [--limit 30]\n  The latest messages of a conversation (at most 200).
  ${T}`,
  send: `openmausbot send TARGET (TEXT | --text TEXT | --message-file FILE | -) [--send-id ID] [--dry-run]
  Send one message and return at once. The same --send-id never sends twice.
  ${T}`,
  "send-channel": "openmausbot send-channel --channel ID (TEXT | --text TEXT) [--task ID] [--dry-run]\n  The same as send, for a room named by id.",
  run: `openmausbot run TARGET (TEXT | --message-file FILE | -) [--task new|current|ID] [--title T]
                [--wait job|turn|none] [--timeout 30m] [--on-input exit|wait|stop] [--on-timeout leave|stop]
                [--strict] [--export DIR [--force]]
  Give a bot or room one job and wait until it, and every teammate it asked, is done.
  It starts a new conversation unless --task says otherwise, prints progress to stderr,
  then the final reply and the files it links. --export writes the job to DIR once it ends
  (a new or empty folder, checked before anything is sent; --force writes into a used one).
  --on-input: exit (3) when someone must answer, wait for the answer, or stop the job.
  --on-timeout: leave the work running, or stop it. --strict: a teammate that failed fails the run.
  Exit 0 done, 1 failed or stopped, 3 needs you, 4 timed out, 130 Ctrl-C (the work keeps running).
  ${T}`,
  wait: `openmausbot wait TARGET [--for job|turn] [--timeout 30m] [--on-input …] [--on-timeout …] [--strict] [--since MS]
  Wait on a conversation already running (after run --wait none, Ctrl-C or a restarted CI step).
  --since MS (which run prints) keeps watching the same job, so one that ended meanwhile reports how.
  Nothing running: it returns at once (exit 0). Same exit codes as run.
  ${T}`,
  interrupt: `openmausbot interrupt TARGET [--tree] [--dry-run]\n  Press Stop on a conversation. --tree also stops every teammate still working on its job.
  ${T}`,
  "new-bot": "openmausbot new-bot NAME [--title T] [--team T] [--model INSTANCE/MODEL] [--effort E]\n  Make a bot.",
  "new-channel": "openmausbot new-channel NAME --members A,B [--team T]\n  Make a room from bots, by name or id.",
  "set-model": "openmausbot set-model BOT --model INSTANCE/MODEL [--effort E] [--task ID] [--dry-run]\n  Change an idle bot's model (or one idle conversation's, with --task).",
  edit: "openmausbot edit BOT --message ID (TEXT | --text TEXT) [--task ID] [--dry-run]\n  Rewrite an earlier message of yours and have the bot answer again from there.",
  export: `openmausbot export TARGET --out DIR [--root ID] [--since MS] [--max-files 200] [--max-screens 100] [--max-bytes 500MB] [--force]
  Write a conversation's job to DIR: the job tree, every transcript (secrets removed),
  the files its replies link to, and screen captures. --root keeps one job.
  ${T}`,
  events: `openmausbot events [--thread ID]… [--job THREAD_ID [--until-settled]] [--kind K,…] [--since CURSOR] [--screens] [--jsonl]
  The server's live events, one JSON line each: messages, threads, bots and rooms, or the kinds --kind names
  (--kind message,runtime adds token-level events to messages).
  --job follows the threads of one conversation's job; --until-settled ends with it.`,
  team: "openmausbot team apply FILE | team export --out FILE   (see help team apply, help team export)",
  "team apply": `openmausbot team apply FILE [--dry-run | --check] [--prune] [--rotate-secrets] [--wait-idle 2m]
  Make the workspace match a team file (YAML or JSON): teams and briefs, bots, skills, Chiefs,
  rooms and engines. Prints the plan, then applies it; a second apply prints "No changes.".
  --dry-run only prints the plan; --check exits 6 if anything would change. --prune deletes bots
  and rooms the file leaves out, in teams marked prune: true. Keys come from { env } or { file },
  and a key already set is kept unless --rotate-secrets. docs/headless-cli.md has the format.`,
  "team export": "openmausbot team export [--team NAME]… --out FILE\n  Write the workspace (or some teams) as a team file; skills go beside it, keys as placeholders,\n  and a key written into a soul, brief or skill is taken out.",
  engine: "openmausbot engine set KIND … | engine list   (see help engine set)",
  "engine set": `openmausbot engine set KIND (--key-env VAR | --key-file FILE) [--base-url URL] [--only-claude-api] [--install] [--rotate] [--dry-run]
  Give the workspace an engine key: claude, openai, openrouter, openai-compatible, xai, groq, greenference, mistral or cerebras.
  The key is never printed. One already set is kept unless --rotate. --install installs the engine's
  command if it is not running already, so a script can run this on every start.
  claude: the key runs every Claude bot; --only-claude-api keeps it to "Claude (API key)" bots.`,
  "engine list": "openmausbot engine list\n  The engines, whether each is ready, and which keys are set (never their values).",
  connect: `openmausbot connect [URL] [--code CODE] --out FILE [--label NAME] [--client] [--force]
  Get a token for a workspace you reach over the network, saved to FILE (only you can read it).
  On this computer's own server the code is made for you; elsewhere, get one from Settings → Phone.
  Then use it: --url URL --token-file FILE (or OPENMAUSBOT_URL and OPENMAUSBOT_TOKEN).`,
  mcp: "openmausbot mcp\n  Serve the OpenMausBot MCP tools on stdin and stdout, for an agent (docs/mcp-server.md).",
};

export interface HeadlessOptions {
  env?: NodeJS.ProcessEnv;
  io?: HeadlessIo;
  callTool?: ClientDeps["callTool"];
  request?: ClientDeps["request"];
  /** control-omb: never change something on a server it merely found. */
  requireExplicitForMutations?: boolean;
  defaultWaitMs?: number;
  signal?: AbortSignal;
}

const VERBS: Record<string, (ctx: VerbContext) => Promise<VerbOutcome>> = {
  doctor, bots: list, channels: list, models: list, messages, send, "send-channel": send, run: runVerb, wait: waitVerb,
  interrupt, "new-bot": newBot, "new-channel": newChannel, "set-model": setModel, edit, export: exportVerb, events: eventsVerb,
  "team apply": teamApplyVerb, "team export": teamExportVerb, "engine set": engineVerb, "engine list": engineVerb, connect: connectVerb,
};

async function execute(argv: readonly string[], options: HeadlessOptions, io: HeadlessIo): Promise<{ outcome: VerbOutcome; output: Output; client?: HeadlessClient }> {
  const helpFor = argv[0] === "help" ? argv.slice(1).join(" ") : undefined;
  const parsed = helpFor !== undefined ? { verb: helpFor, flags: { help: true }, positionals: [] } : parseCommand(argv);
  const output = new Output(io, { json: parsed.flags.json === true, quiet: parsed.flags.quiet === true });
  if (parsed.flags.help) {
    const text = VERB_HELP[parsed.verb] ?? HEADLESS_USAGE;
    return { outcome: { result: { help: text }, exitCode: EXIT.done, human: [text] }, output };
  }
  if (parsed.verb === "mcp") {
    await (await loadMcp()).runStdio();
    return { outcome: { result: null, exitCode: EXIT.done, human: [], printed: true }, output };
  }
  const env = options.env ?? process.env;
  let client: HeadlessClient | undefined;
  let opening: Promise<HeadlessClient> | undefined;
  const ctx: VerbContext = {
    verb: parsed.verb, flags: parsed.flags, positionals: parsed.positionals, env, io, output,
    client: () => (opening ??= openClient(parsed.flags, { env, ...(options.callTool ? { callTool: options.callTool } : {}),
      ...(options.request ? { request: options.request } : {}), requireExplicitForMutations: options.requireExplicitForMutations === true },
    MUTATING_VERBS.has(parsed.verb)).then((opened) => (client = opened))),
    signal: options.signal ?? new AbortController().signal,
    defaultWaitMs: options.defaultWaitMs ?? 30 * 60_000,
  };
  try {
    return { outcome: await VERBS[parsed.verb]!(ctx), output, ...(client ? { client } : {}) };
  } catch (error) {
    throw await explain(error, client?.baseUrl);
  }
}

export async function runHeadlessCommand(argv: readonly string[], options: HeadlessOptions = {}): Promise<unknown> {
  const quiet: HeadlessIo = { out: () => undefined, err: () => undefined, readStdin: async () => "" };
  const { outcome } = await execute(argv, options, options.io ?? quiet);
  return outcome.result;
}

/** These stop waiting on Ctrl-C (the work goes on) and say how to pick it up again; every other verb just ends. */
const STOPS_WAITING_ON_CTRL_C: ReadonlySet<string> = new Set(["run", "wait", "events"]);

export async function runHeadless(argv: readonly string[], options: HeadlessOptions = {}): Promise<number> {
  const io = options.io ?? processIo();
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  if (STOPS_WAITING_ON_CTRL_C.has(argv[0] ?? "")) process.once("SIGINT", onSignal);
  const json = argv.includes("--json");
  try {
    const { outcome, output } = await execute(argv, { ...options, signal: options.signal ?? controller.signal }, io);
    if (!outcome.printed) output.result(outcome.result, outcome.human);
    return outcome.exitCode;
  } catch (error) {
    const reported = error instanceof HeadlessError ? error : await explain(error);
    new Output(io, { json }).error(reported);
    return reported.exitCode;
  } finally {
    process.removeListener("SIGINT", onSignal);
  }
}

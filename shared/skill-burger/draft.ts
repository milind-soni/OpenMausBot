// A finished run as a draft workflow. Nobody fills a form: values the person typed in the ask become args (the recorded
// value is the default); values an earlier step returned are piped from it; long text the AI wrote from something it
// read becomes an AI step that writes it again next time. A step that can't be repeated exactly (its input was clipped
// or masked, it ran code, it clicked in a browser, it used a temporary folder of that run) is saved as an AI step, never
// guessed. Work handed to teammates is one delegate step: who, what each was asked, what done means, and how many
// rounds of fixes the run took; the review that closed the run is an AI step. No secret is written down.
import { redactSecretsInText } from "../redact.ts";
import { DELEGATE_MAX_ROUNDS, textLine, type Workflow, type WorkflowRef, type WorkflowStep, type WorkflowTeammate, type WorkflowText } from "./format.ts";
import { appMeta, BARE_READ } from "./apps.ts";
import { askOf, askTextOf, burgerLayers, burgerWorthy, type BurgerLayer, type RunMessage } from "./layers.ts";

const PIPE_MIN = 6;
const ARG_MIN = 3;
const COMPOSED_MIN = 200;
const HEREDOC_MIN = 120;
const EXAMPLE_MAX = 2_000;
const CONTEXT_MAX = 1_500;
const SEARCH_BUDGET = 5_000;
const MASKED = /••••••|«redacted \d+ chars»/;
/** A conversation's own folder (task-workspaces/<bot>/<thread>): next time the run is in another conversation's folder. */
const CONVERSATION_FOLDER = /(?:[A-Za-z]:)?(?:[\\/][^\s"'`\\/;|&<>()]+)*[\\/]task-workspaces[\\/][0-9a-f-]{36}[\\/][0-9a-f-]{36}/g;
/** A temporary folder that run made for itself (mktemp): gone next time. */
const RUN_TEMP = /(?:\/private)?\/var\/folders\/[^\s"']+\/T\/tmp\.[A-Za-z0-9]+|\/tmp\/tmp\.[A-Za-z0-9]{6,}/;
const SHELL_WORDS = new Set(["for", "in", "do", "done", "if", "then", "else", "fi", "while", "until", "case", "esac", "function", "select", "echo", "true", "false"]);
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\b/;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const capital = (words: string) => (words ? words[0]!.toUpperCase() + words.slice(1) : words);

const PLACE_WORDS: Partial<Record<BurgerLayer["where"], string>> = { vm: "on the cloud computer", yourComputer: "on the person's own computer", browser: "in the browser" };

/** "Kiwi, Rio and Miso". */
export function namesLine(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";
}

/** The line a layer gets: an app's action, "Run git push", "Write notes.md", "Open example.com", "Ask Kiwi and Rio". */
export function layerLabel(layer: Pick<BurgerLayer, "kind" | "words" | "app"> & { read?: boolean; review?: true }): string {
  if (layer.kind === "app" && layer.app && BARE_READ.test(layer.words)) return `Read from ${appMeta(layer.app).label}`;
  if (layer.review) return "Review what came back and report";
  switch (layer.kind) {
    case "shell": return layer.read ? `Fetch ${layer.words}` : `Run ${layer.words}`;
    case "file": return `Write ${layer.words}`;
    case "browser": return `Open ${layer.words}`;
    case "delegate": return `Ask ${namesLine(layer.words.split(", "))}`;
    default: return capital(layer.words);
  }
}

function parsedOutput(layer: BurgerLayer): unknown {
  if (layer.delegation) return { replies: Object.fromEntries(layer.delegation.replies.map((reply) => [reply.name, reply.text])) };
  if (!layer.output) return undefined;
  let value: unknown;
  try { value = JSON.parse(layer.output); } catch { return layer.output; }
  // One tool of a multi-app call answers in its own slot of the shared result.
  const index = /#(\d+)$/.exec(layer.id)?.[1];
  const results = isRecord(value) && isRecord(value.data) && Array.isArray(value.data.results) ? value.data.results : undefined;
  return index !== undefined && results ? results[Number(index)] : value;
}

/** Where `target` sits in `value`, as a dotted path; "" for the value itself. */
function findPath(value: unknown, target: string): string | null {
  let budget = SEARCH_BUDGET;
  const walk = (node: unknown, path: string[], depth: number): string | null => {
    if (--budget < 0 || depth > 8) return null;
    if (typeof node === "string") return node === target ? path.join(".") : null;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) { const hit = walk(node[i], [...path, String(i)], depth + 1); if (hit !== null) return hit; }
    } else if (isRecord(node)) {
      for (const [key, child] of Object.entries(node)) { const hit = walk(child, [...path, key], depth + 1); if (hit !== null) return hit; }
    }
    return null;
  };
  return walk(value, [], 0);
}

function argName(key: string | undefined, taken: Record<string, unknown>): string {
  const stem = (key ?? "value").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "").replace(/_(?:email|emails|address|addresses)$/, "").slice(0, 32) || "value";
  if (!(stem in taken)) return stem;
  for (let n = 2; ; n += 1) if (!(`${stem}_${n}` in taken)) return `${stem}_${n}`;
}

/** A value in the ask whose kind gives it a name: a web address, an email, a site, a file, a path, a date, quoted words. */
export interface AskValue { value: string; name: string }
const FILE_EXT = /\.(?:md|csv|json|txt|py|js|ts|tsx|html|ya?ml|pdf|png|jpe?g|sh|log|xlsx?|docx?|zip|toml|xml|sql)$/i;

/** The typed values of an ask, longest first so a web address wins over the site inside it. */
export function askValues(ask: string): AskValue[] {
  const found = new Map<string, string>();
  const add = (value: string, name: string) => { const clean = value.replace(/[.,;:!?)\]]+$/, ""); if (clean.length >= ARG_MIN && !found.has(clean)) found.set(clean, name); };
  for (const match of ask.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    let path = "/";
    try { path = new URL(match[0].replace(/[.,;:!?)\]]+$/, "")).pathname; } catch { /* keep "/" */ }
    add(match[0], path === "/" || path === "" ? "site" : "url");
  }
  for (const match of ask.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) add(match[0], "email");
  const outsideUrls = ask.replace(/https?:\/\/[^\s"'<>]+/g, " ").replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, " ");
  for (const match of outsideUrls.matchAll(/(?:~|\.{1,2})?\/[\w.-]+(?:\/[\w.-]+)+/g)) add(match[0], "path");
  for (const match of outsideUrls.matchAll(/\b[\w-]+(?:\.[\w-]+)+\b/g)) {
    if (FILE_EXT.test(match[0])) add(match[0], "file");
    else if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(match[0]) && !/^\d/.test(match[0])) add(match[0], "site");
  }
  for (const match of ask.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) add(match[0], "date");
  for (const match of ask.matchAll(/"([^"\n]{3,80})"|“([^”\n]{3,80})”/g)) add(match[1] ?? match[2]!, "text");
  return [...found].map(([value, name]) => ({ value, name })).sort((a, b) => b.value.length - a.value.length);
}

interface Recorded { id: string; output: unknown; read: boolean }

export interface DraftOptions {
  summary?: string;
  /** Who a teammate is, from the id or name the run used: its name and role now. */
  teammate?: (idOrName: string) => { id?: string; name: string; role?: string } | undefined;
}

class Drafter {
  readonly args: Workflow["args"] = {};
  readonly steps: WorkflowStep[] = [];
  private readonly recorded: Recorded[] = [];
  private readonly ask: string;
  private readonly askText: string;
  private readonly typed: AskValue[];
  private readonly summary: string;
  private readonly options: DraftOptions;

  constructor(ask: string, summary: string, options: DraftOptions = {}) {
    this.askText = ask;
    this.ask = ask.toLowerCase();
    this.summary = summary;
    this.typed = askValues(ask);
    this.options = options;
  }

  /** A whole word of the ask, not part of one ("site" is not in "sites"). */
  private wordInAsk(word: string): boolean {
    if (word.length < ARG_MIN || /^\d{1,2}$/.test(word) || !/^[\w.@:/-]+$/.test(word)) return false;
    return new RegExp(`(?:^|[^\\w.-])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\w-])`, "i").test(this.askText);
  }

  private inAsk(value: string): boolean {
    return value.length >= ARG_MIN && !/^\d{1,2}$/.test(value) && this.ask.includes(value.toLowerCase());
  }

  private askArg(value: string, key: string | undefined): WorkflowRef {
    const existing = Object.entries(this.args).find(([, arg]) => arg.default === value)?.[0];
    if (existing) return { $arg: existing };
    // A connected app's field names its value best ("recipient_email" → recipient); text and commands have only the kind.
    const typed = this.typed.find((one) => one.value === value)?.name;
    const name = argName(key ?? typed, this.args);
    this.args[name] = { default: value, ...(key ? { label: key.replace(/_/g, " ").slice(0, 80) } : typed ? { label: typed } : {}) };
    return { $arg: name };
  }

  private pipe(value: string): WorkflowRef | null {
    if (value.length < PIPE_MIN) return null;
    for (let i = this.recorded.length - 1; i >= 0; i -= 1) {
      const path = findPath(this.recorded[i]!.output, value);
      if (path !== null) return { $step: this.recorded[i]!.id, ...(path ? { path } : {}) };
    }
    return null;
  }

  /** An AI step that writes `field` from the last thing the run read, with the recorded text as its example. With only a
   * look at a page or a file behind it (nothing piped), it reads that again itself. */
  private composer(id: string, field: string, example: string, looked = false, file?: string): WorkflowRef | null {
    const read = [...this.recorded].reverse().find((entry) => entry.read) ?? [...this.recorded].reverse().find((entry) => entry.output !== undefined && entry.output !== "");
    if (!read && !looked) return null;
    const aiId = `${id}_write`;
    const what = file ?? `the ${field.replace(/_/g, " ")}`;
    const request = this.request(400);
    this.steps.push({
      id: aiId, kind: "ai", deterministic: false, label: `Write ${what}`.slice(0, 120),
      prompt: read
        ? `Write ${what} from the input, for the request: ${request}. Match the example's length and tone; the values come from the input, not the example.`
        : `Write ${what} again from what you read or look at now, for the request: ${request}. Match the example's shape; don't copy its values.`,
      ...(read ? { input: { $step: read.id } } : {}), example: example.slice(0, EXAMPLE_MAX),
    });
    return { $step: aiId };
  }

  /** One string from a recorded call: piped, made an arg, written by an AI step, or kept as it was. */
  private value(id: string, value: string, key: string | undefined, looked = false, file?: string): unknown {
    const piped = this.pipe(value);
    if (piped) return piped;
    if (this.inAsk(value)) return this.askArg(value, key);
    if (value.length >= COMPOSED_MIN || (value.includes("\n") && value.length >= 40)) return this.composer(id, key ?? "text", value, looked, file) ?? value;
    return value;
  }

  private values(id: string, node: unknown, key?: string): unknown {
    if (typeof node === "string") return this.value(id, node, key);
    if (Array.isArray(node)) return node.map((item) => this.values(id, item, key));
    if (isRecord(node)) return Object.fromEntries(Object.entries(node).map(([childKey, child]) => [childKey, this.values(id, child, childKey)]));
    return node;
  }

  /** The person's request in a prompt, each of its inputs as {name}: the runner fills in this run's values. */
  private request(max: number): string {
    return textLine(this.text(this.askText.replace(/\s+/g, " ").slice(0, max) || this.summary));
  }

  /** A message with the ask's typed values in it as parts: ["QA-test ", {"$arg": "site"}, " for…"]. */
  private text(message: string): WorkflowText {
    const parts: Array<string | WorkflowRef> = [message];
    for (const { value } of this.typed) {
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i];
        if (typeof part !== "string" || !part.includes(value)) continue;
        const pieces = part.split(value);
        const ref = this.askArg(value, undefined);
        parts.splice(i, 1, ...pieces.flatMap((piece, index) => (index ? [ref, piece] : [piece])));
        i += pieces.length * 2 - 2;
      }
    }
    const clean = parts.filter((part) => part !== "");
    return clean.length === 1 && typeof clean[0] === "string" ? clean[0] : clean;
  }

  /** Values the person typed that the command repeats become OMB_ARG_<NAME>, where the shell would expand them: a typed
   * value (a web address, a site, a file) outside single quotes; a plain word only as a whole argument outside any quotes,
   * never a program's name and never inside code a command carries in quotes. */
  private shell(run: string): string {
    let out = run;
    const plain = [...new Set(run.split(/[\s;&|()]+/).map((word) => word.replace(/^["'`]+|["'`;,)]+$/g, "")).filter((word) => !word.startsWith("-") && !SHELL_WORDS.has(word) && this.wordInAsk(word)))];
    const candidates = [...this.typed.map((one) => ({ value: one.value, typed: true })), ...plain.filter((word) => !this.typed.some((one) => one.value === word)).map((value) => ({ value, typed: false }))];
    for (const { value, typed } of candidates) {
      if (!out.includes(value)) continue;
      const flag = /(?:^|\s)--?([a-z][a-z0-9-]*)[\s=]+["']?$/i.exec(out.slice(0, Math.max(0, out.indexOf(value))))?.[1]?.replace(/-/g, "_");
      const existing = Object.entries(this.args).find(([, arg]) => arg.default === value)?.[0];
      const name = existing ?? argName(typed ? this.typed.find((one) => one.value === value)!.name : flag, this.args);
      const env = `$OMB_ARG_${name.toUpperCase()}`;
      let quote: string | null = null;
      let rebuilt = "";
      let atCommand = true;
      for (let i = 0; i < out.length; i += 1) {
        const char = out[i]!;
        // A file the person named may sit in a folder ("./top5.md"): a slash before it is still its start.
        const before = typed && FILE_EXT.test(value) ? /[\w.-]/ : /[\w./-]/;
        const boundary = !before.test(out[i - 1] ?? " ") && !/[\w./-]/.test(out[i + value.length] ?? " ");
        const allowed = typed ? quote !== "'" : quote === null && !atCommand;
        if (out.startsWith(value, i) && boundary && allowed) {
          rebuilt += quote === '"' ? env : `"${env}"`;
          i += value.length - 1;
          atCommand = false;
          continue;
        }
        if (char === "\\" && quote !== "'") { rebuilt += out.slice(i, i + 2); i += 1; continue; }
        if ((char === "'" || char === '"') && (quote === null || quote === char)) quote = quote ? null : char;
        if (quote === null && /[;&|\n(]/.test(char)) atCommand = true;
        else if (quote === null && !/\s/.test(char) && atCommand && !/[;&|\n(]/.test(char)) {
          // The first word of a command is its program; skip it, and any VAR=value before it.
          const word = /^[^\s;&|]+/.exec(out.slice(i))?.[0] ?? "";
          if (word === "for" || word === "select") {
            // `for NAME in …`: the loop's own variable is never an arg.
            const loop = /^(?:for|select)\s+\w+/.exec(out.slice(i))?.[0] ?? word;
            rebuilt += loop; i += loop.length - 1; atCommand = false; continue;
          }
          if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) && word !== "cd" && word !== "sudo" && word !== "env") { rebuilt += word; i += word.length - 1; atCommand = false; continue; }
        }
        rebuilt += char;
      }
      if (rebuilt === out) continue;
      if (!(name in this.args)) this.args[name] = { default: value, ...(typed ? { label: this.typed.find((one) => one.value === value)!.name } : flag ? { label: flag.replace(/_/g, " ") } : {}) };
      out = rebuilt;
    }
    return out;
  }

  private ai(id: string, layer: BurgerLayer, label: string, why = ""): WorkflowStep {
    const call = layer.args ? redactSecretsInText(JSON.stringify(layer.args)).slice(0, CONTEXT_MAX) : "";
    const where = layer.kind === "app" && layer.app ? `in ${appMeta(layer.app).label}` : PLACE_WORDS[layer.where] ?? "";
    const desktop = layer.kind === "computer" ? " Look at the screen first: it may not look the same as last time." : "";
    return {
      id, kind: "ai", deterministic: false, label,
      prompt: `Do this step again: ${label}${where ? ` ${where}` : ""}.${why}${desktop}${call ? ` Last time the call was ${layer.tool} with ${call}` : ""}`.slice(0, 4_000),
    };
  }

  private teammate(bot: { id?: string; name: string }): WorkflowTeammate {
    const known = (bot.id && this.options.teammate?.(bot.id)) || this.options.teammate?.(bot.name);
    const name = (known?.name ?? bot.name).slice(0, 80);
    const id = known?.id ?? bot.id;
    return { ...(id ? { id } : {}), name, ...(known?.role ? { role: known.role.slice(0, 120) } : {}) };
  }

  private delegate(id: string, layer: BurgerLayer, label: string): WorkflowStep {
    const [first = [], ...later] = layer.delegation!.rounds;
    const tasks = first.flatMap((call) => call.bots.map((bot) => ({ bot: this.teammate(bot), message: this.text(call.message), ...(call.doneWhen ? { doneWhen: call.doneWhen.slice(0, 1_000) } : {}) })));
    const unique = tasks.filter((task, index) => tasks.findIndex((other) => other.bot.name === task.bot.name) === index).slice(0, 8);
    // What an extra round asked, with this run's inputs shown as their names, so a later run doesn't copy its values.
    const example = later.flat().map((call) => `${namesLine(call.bots.map((bot) => this.teammate(bot).name))}: ${textLine(this.text(call.message))}`).join("\n").slice(0, EXAMPLE_MAX);
    const rounds = Math.min(DELEGATE_MAX_ROUNDS, Math.max(later.length, unique.some((task) => task.doneWhen) ? 1 : 0));
    return {
      id, kind: "delegate", label, tasks: unique,
      ...(first.some((call) => call.consult) ? { consult: true } : {}),
      ...(rounds ? { review: { rounds, ...(example ? { example } : {}) } } : {}),
    };
  }

  add(layer: BurgerLayer, index: number): void {
    const id = `s${index + 1}`;
    const label = layerLabel(layer).slice(0, 120);
    const raw = layer.args === undefined ? "" : JSON.stringify(layer.args);
    const command = layer.kind === "shell" ? String(layer.args?.command ?? "") : "";
    const heredoc = command ? HEREDOC.exec(command) : null;
    if (raw && !layer.review && (MASKED.test(raw) || redactSecretsInText(raw) !== raw)) {
      // A secret was part of the call: the step is saved without it, for the AI to do again with the person's own key.
      this.steps.push({ id, kind: "ai", deterministic: false, label, prompt: `Do this step again: ${label}. It used a secret, so it isn't saved here.` });
    } else if (layer.kind === "delegate" && layer.delegation) {
      this.steps.push(this.delegate(id, layer, label));
    } else if (layer.review) {
      const from = [...this.steps].reverse().find((step) => step.kind === "delegate");
      const words = String(layer.args?.text ?? "");
      this.steps.push({
        id, kind: "ai", deterministic: false, label,
        prompt: `Review what came back against the request and report to the person: ${this.request(600)}`,
        ...(from ? { input: { $step: from.id, path: "text" } } : {}), ...(words ? { example: redactSecretsInText(words).slice(0, EXAMPLE_MAX) } : {}),
      });
    } else if (layer.replay !== "exact" || !layer.args) {
      this.steps.push(this.ai(id, layer, label));
    } else if (layer.kind === "app") {
      this.steps.push({ id, kind: "app", label, app: layer.app!, tool: layer.tool, args: this.values(id, layer.args) as Record<string, unknown>, ...(layer.account ? { account: layer.account } : {}) });
    } else if (layer.kind === "shell" && RUN_TEMP.test(command)) {
      this.steps.push(this.ai(id, layer, label, " It used a temporary folder of that run, which is gone now, so redo it with fresh ones."));
    } else if (layer.kind === "shell" && heredoc && heredoc[3]!.trim().length >= HEREDOC_MIN && layer.afterRead) {
      // The command wrote text the AI composed from what it read: write it again from what is there now.
      const target = /(?:>{1,2})\s*["']?([^\s"';|&]+)/.exec(command)?.[1]?.split("/").pop() ?? "the file";
      const read = [...this.recorded].reverse().find((entry) => entry.read);
      this.steps.push({
        id, kind: "ai", deterministic: false, label: `Write ${target}`.slice(0, 120), ...(read ? { input: { $step: read.id } } : {}),
        prompt: `Write ${target} again from what this run reads now, for the request: ${this.request(400)}. Match the example's shape; don't copy its values. Last time the command was: ${redactSecretsInText(command.replace(CONVERSATION_FOLDER, ".").split("\n", 1)[0]!).slice(0, 300)}`,
        example: redactSecretsInText(heredoc[3]!).slice(0, EXAMPLE_MAX),
      });
    } else if (layer.kind === "shell") {
      const cwd = typeof layer.args.cwd === "string" && !new RegExp(CONVERSATION_FOLDER.source).test(layer.args.cwd) ? layer.args.cwd : undefined;
      this.steps.push({ id, kind: "shell", label: label.replace(CONVERSATION_FOLDER, "."), run: this.shell(command.replace(CONVERSATION_FOLDER, ".")), ...(cwd ? { cwd } : {}) });
    } else if (layer.kind === "file") {
      const content = String(layer.args.content ?? "");
      const path = String(layer.args.path).replace(CONVERSATION_FOLDER, ".");
      this.steps.push({ id, kind: "file", label, path, content: (this.value(id, content, "content", layer.afterRead, path.split(/[\\/]/).pop()) as string | WorkflowRef) });
    } else if (layer.kind === "browser") {
      const url = String(layer.args.url);
      this.steps.push({ id, kind: "browser", label, action: "open", url: this.inAsk(url) ? this.askArg(url, "url") : url });
    } else {
      this.steps.push(this.ai(id, layer, label));
    }
    const step = this.steps[this.steps.length - 1];
    if (step && step.id === id) step.where = layer.where;
    this.recorded.push({ id, output: parsedOutput(layer), read: layer.read || layer.kind === "delegate" });
  }
}

/** Every string in the saved file passes the secret scrub; a step it changes is saved as an AI step instead. */
function scrubbed(step: WorkflowStep, layer: BurgerLayer | undefined, drafter: { ai(step: WorkflowStep): WorkflowStep }): WorkflowStep {
  const text = JSON.stringify(step);
  const clean = redactSecretsInText(text);
  if (clean === text) return step;
  if (step.kind === "ai" || step.kind === "delegate" || !layer) return JSON.parse(clean) as WorkflowStep;
  return drafter.ai(step);
}

export interface WorkflowDraft { workflow: Workflow; layers: BurgerLayer[] }

/** The run since the person's last ask as a workflow, or null when it has fewer than two finished steps. */
export function draftWorkflow(messages: readonly RunMessage[], options: DraftOptions = {}): WorkflowDraft | null {
  const layers = burgerLayers(messages).filter((layer) => layer.status === "done");
  if (!burgerWorthy(layers)) return null;
  const ask = askOf(messages) ?? "";
  const summary = (options.summary?.trim() || ask || layers.map(layerLabel).join(", ")).replace(/\s+/g, " ").slice(0, 160);
  return { workflow: draftFromLayers(layers, askTextOf(messages) ?? ask, summary, options), layers };
}

/** Finished layers as a workflow's steps and args, with the same pipes, args, AI steps and scrubbing as a whole run. */
export function draftFromLayers(layers: readonly BurgerLayer[], ask: string, summary: string, options: DraftOptions = {}): Workflow {
  const drafter = new Drafter(ask, summary, options);
  layers.forEach((layer, index) => drafter.add(layer, index));
  const byId = new Map(layers.map((layer, index) => [`s${index + 1}`, layer]));
  const steps = drafter.steps.map((step) => scrubbed(step, byId.get(step.id), {
    ai: (secret) => ({ id: secret.id, kind: "ai", deterministic: false, label: secret.label, prompt: `Do this step again: ${secret.label}. It used a secret, so it isn't saved here.` }),
  }));
  const args = JSON.parse(redactSecretsInText(JSON.stringify(drafter.args))) as Workflow["args"];
  return { version: 1, summary: redactSecretsInText(summary), args, steps };
}

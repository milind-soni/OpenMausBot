// A finished run as a draft workflow. Nobody fills a form: values the person typed in the ask become args (the recorded
// value is the default); values an earlier step returned are piped from it; long text the AI wrote from something it
// read becomes an AI step that writes it again next time. A step that can't be repeated exactly (its input was clipped
// or masked, it ran code, it clicked in a browser) is saved as an AI step, never guessed. No secret is written down.
import { redactSecretsInText } from "../redact.ts";
import type { Workflow, WorkflowRef, WorkflowStep } from "./format.ts";
import { appMeta, BARE_READ } from "./apps.ts";
import { askOf, burgerLayers, type BurgerLayer, type RunMessage } from "./layers.ts";

const PIPE_MIN = 6;
const ARG_MIN = 3;
const COMPOSED_MIN = 200;
const EXAMPLE_MAX = 2_000;
const CONTEXT_MAX = 1_500;
const SEARCH_BUDGET = 5_000;
const MASKED = /••••••|«redacted \d+ chars»/;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const capital = (words: string) => (words ? words[0]!.toUpperCase() + words.slice(1) : words);

const PLACE_WORDS: Partial<Record<BurgerLayer["where"], string>> = { vm: "on the cloud computer", yourComputer: "on the person's own computer", browser: "in the browser" };

/** The line a layer gets: an app's action, "Run git push", "Write notes.md", "Open example.com". */
export function layerLabel(layer: Pick<BurgerLayer, "kind" | "words" | "app">): string {
  if (layer.kind === "app" && layer.app && BARE_READ.test(layer.words)) return `Read from ${appMeta(layer.app).label}`;
  switch (layer.kind) {
    case "shell": return `Run ${layer.words}`;
    case "file": return `Write ${layer.words}`;
    case "browser": return `Open ${layer.words}`;
    default: return capital(layer.words);
  }
}

function parsedOutput(layer: BurgerLayer): unknown {
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

interface Recorded { id: string; output: unknown; read: boolean }

class Drafter {
  readonly args: Workflow["args"] = {};
  readonly steps: WorkflowStep[] = [];
  private readonly recorded: Recorded[] = [];
  private readonly ask: string;
  private readonly summary: string;

  constructor(ask: string, summary: string) {
    this.ask = ask.toLowerCase();
    this.summary = summary;
  }

  private inAsk(value: string): boolean {
    return value.length >= ARG_MIN && !/^\d{1,2}$/.test(value) && this.ask.includes(value.toLowerCase());
  }

  private askArg(value: string, key: string | undefined): WorkflowRef {
    const existing = Object.entries(this.args).find(([, arg]) => arg.default === value)?.[0];
    if (existing) return { $arg: existing };
    const name = argName(key, this.args);
    this.args[name] = { default: value, ...(key ? { label: key.replace(/_/g, " ").slice(0, 80) } : {}) };
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

  /** An AI step that writes `field` from the last thing the run read, with the recorded text as its example. */
  private composer(id: string, field: string, example: string): WorkflowRef | null {
    const read = [...this.recorded].reverse().find((entry) => entry.read);
    if (!read) return null;
    const aiId = `${id}_write`;
    this.steps.push({
      id: aiId, kind: "ai", deterministic: false, label: `Write the ${field.replace(/_/g, " ")}`,
      prompt: `Write the ${field.replace(/_/g, " ")} for "${this.summary}" from the input. Match the example's length and tone.`,
      input: { $step: read.id }, example: example.slice(0, EXAMPLE_MAX),
    });
    return { $step: aiId };
  }

  /** One string from a recorded call: piped, made an arg, written by an AI step, or kept as it was. */
  private value(id: string, value: string, key: string | undefined): unknown {
    const piped = this.pipe(value);
    if (piped) return piped;
    if (this.inAsk(value)) return this.askArg(value, key);
    if (value.length >= COMPOSED_MIN || (value.includes("\n") && value.length >= 40)) return this.composer(id, key ?? "text", value) ?? value;
    return value;
  }

  private values(id: string, node: unknown, key?: string): unknown {
    if (typeof node === "string") return this.value(id, node, key);
    if (Array.isArray(node)) return node.map((item) => this.values(id, item, key));
    if (isRecord(node)) return Object.fromEntries(Object.entries(node).map(([childKey, child]) => [childKey, this.values(id, child, childKey)]));
    return node;
  }

  /** Words the person typed that the command repeats become OMB_ARG_<NAME>, where the shell would expand them. */
  private shell(run: string): string {
    const words = [...new Set(run.split(/\s+/).slice(1).map((word) => word.replace(/^["'`]+|["'`;,)]+$/g, "")).filter((word) => !word.startsWith("-") && this.inAsk(word)))];
    let out = run;
    for (const word of words) {
      const flag = /(?:^|\s)--?([a-z][a-z0-9-]*)[\s=]+["']?$/i.exec(out.slice(0, Math.max(0, out.indexOf(word))))?.[1]?.replace(/-/g, "_");
      const name = Object.entries(this.args).find(([, arg]) => arg.default === word)?.[0] ?? argName(flag, this.args);
      const env = `$OMB_ARG_${name.toUpperCase()}`;
      let quote: string | null = null;
      let rebuilt = "";
      for (let i = 0; i < out.length; i += 1) {
        const char = out[i]!;
        if (out.startsWith(word, i) && quote !== "'" && !/[\w./-]/.test(out[i - 1] ?? " ") && !/[\w./-]/.test(out[i + word.length] ?? " ")) {
          rebuilt += quote === '"' ? env : `"${env}"`;
          i += word.length - 1;
          continue;
        }
        if ((char === "'" || char === '"') && (quote === null || quote === char)) quote = quote ? null : char;
        rebuilt += char;
      }
      if (rebuilt === out) continue;
      if (!(name in this.args)) this.args[name] = { default: word, ...(flag ? { label: flag.replace(/_/g, " ") } : {}) };
      out = rebuilt;
    }
    return out;
  }

  private ai(id: string, layer: BurgerLayer, label: string): WorkflowStep {
    const call = layer.args ? redactSecretsInText(JSON.stringify(layer.args)).slice(0, CONTEXT_MAX) : "";
    const where = layer.kind === "app" && layer.app ? `in ${appMeta(layer.app).label}` : PLACE_WORDS[layer.where] ?? "";
    const desktop = layer.kind === "computer" ? " Look at the screen first: it may not look the same as last time." : "";
    return {
      id, kind: "ai", deterministic: false, label,
      prompt: `Do this step again: ${label}${where ? ` ${where}` : ""}.${desktop}${call ? ` Last time the call was ${layer.tool} with ${call}` : ""}`.slice(0, 4_000),
    };
  }

  add(layer: BurgerLayer, index: number): void {
    const id = `s${index + 1}`;
    const label = layerLabel(layer).slice(0, 120);
    const raw = layer.args === undefined ? "" : JSON.stringify(layer.args);
    if (raw && (MASKED.test(raw) || redactSecretsInText(raw) !== raw)) {
      // A secret was part of the call: the step is saved without it, for the AI to do again with the person's own key.
      this.steps.push({ id, kind: "ai", deterministic: false, label, prompt: `Do this step again: ${label}. It used a secret, so it isn't saved here.` });
    } else if (layer.replay !== "exact" || !layer.args) {
      this.steps.push(this.ai(id, layer, label));
    } else if (layer.kind === "app") {
      this.steps.push({ id, kind: "app", label, app: layer.app!, tool: layer.tool, args: this.values(id, layer.args) as Record<string, unknown>, ...(layer.account ? { account: layer.account } : {}) });
    } else if (layer.kind === "shell") {
      const cwd = typeof layer.args.cwd === "string" ? layer.args.cwd : undefined;
      this.steps.push({ id, kind: "shell", label, run: this.shell(String(layer.args.command)), ...(cwd ? { cwd } : {}) });
    } else if (layer.kind === "file") {
      const content = String(layer.args.content ?? "");
      this.steps.push({ id, kind: "file", label, path: String(layer.args.path), content: (this.value(id, content, "content") as string | WorkflowRef) });
    } else if (layer.kind === "browser") {
      const url = String(layer.args.url);
      this.steps.push({ id, kind: "browser", label, action: "open", url: this.inAsk(url) ? this.askArg(url, "url") : url });
    } else {
      this.steps.push(this.ai(id, layer, label));
    }
    const step = this.steps[this.steps.length - 1];
    if (step && step.id === id) step.where = layer.where;
    this.recorded.push({ id, output: parsedOutput(layer), read: layer.read });
  }
}

/** Every string in the saved file passes the secret scrub; a step it changes is saved as an AI step instead. */
function scrubbed(step: WorkflowStep, layer: BurgerLayer | undefined, drafter: { ai(step: WorkflowStep): WorkflowStep }): WorkflowStep {
  const text = JSON.stringify(step);
  const clean = redactSecretsInText(text);
  if (clean === text) return step;
  if (step.kind === "ai" || !layer) return JSON.parse(clean) as WorkflowStep;
  return drafter.ai(step);
}

export interface WorkflowDraft { workflow: Workflow; layers: BurgerLayer[] }

/** The run since the person's last ask as a workflow, or null when it has fewer than two finished steps. */
export function draftWorkflow(messages: readonly RunMessage[], options: { summary?: string } = {}): WorkflowDraft | null {
  const layers = burgerLayers(messages).filter((layer) => layer.status === "done");
  if (layers.length < 2) return null;
  const ask = askOf(messages) ?? "";
  const summary = (options.summary?.trim() || ask || layers.map(layerLabel).join(", ")).replace(/\s+/g, " ").slice(0, 160);
  return { workflow: draftFromLayers(layers, ask, summary), layers };
}

/** Finished layers as a workflow's steps and args, with the same pipes, args, AI steps and scrubbing as a whole run. */
export function draftFromLayers(layers: readonly BurgerLayer[], ask: string, summary: string): Workflow {
  const drafter = new Drafter(ask, summary);
  layers.forEach((layer, index) => drafter.add(layer, index));
  const byId = new Map(layers.map((layer, index) => [`s${index + 1}`, layer]));
  const steps = drafter.steps.map((step) => scrubbed(step, byId.get(step.id), {
    ai: (secret) => ({ id: secret.id, kind: "ai", deterministic: false, label: secret.label, prompt: `Do this step again: ${secret.label}. It used a secret, so it isn't saved here.` }),
  }));
  const args = JSON.parse(redactSecretsInText(JSON.stringify(drafter.args))) as Workflow["args"];
  return { version: 1, summary: redactSecretsInText(summary), args, steps };
}

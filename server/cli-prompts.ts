import { confirm as clackConfirm, isCancel, password, select, text } from "@clack/prompts";
import { createInterface } from "node:readline";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";

export interface SetupIo {
  log(line: string): void;
  ask(question: string): Promise<string>;
  secret(question: string): Promise<string>;
  choose(question: string, options: readonly string[], defaultIndex?: number): Promise<number>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
}

export class SetupCancelled extends Error {
  constructor() {
    super("Setup cancelled.");
    this.name = "SetupCancelled";
  }
}

type TerminalInput = Readable & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};
type TerminalOutput = Writable & { isTTY?: boolean; columns?: number; rows?: number };
type PromptContext = { input: TerminalInput; output: TerminalOutput; signal: AbortSignal };

function displayText(value: string, multiline = false): string {
  const plain = stripVTControlCharacters(value);
  // Provider-supplied labels must not issue terminal control commands.
  // eslint-disable-next-line no-control-regex
  return plain.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => character === "\n" && multiline ? "\n" : " ");
}

/** A line-based fallback with no cursor/color output. Readline has no output
 * stream for secrets, so even pasted input cannot be echoed. */
function plainText(question: string, hidden: boolean, context: PromptContext): Promise<string> {
  const { input, output, signal } = context;
  return new Promise((resolve, reject) => {
    input.setRawMode?.(hidden);
    const rl = createInterface({ input, terminal: hidden });
    let finished = false;
    const finish = (answer?: string, error?: unknown) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", cancel);
      rl.close();
      output.write("\n");
      if (error) reject(error);
      else resolve(answer ?? "");
    };
    const cancel = () => finish(undefined, signal.reason ?? new SetupCancelled());
    signal.addEventListener("abort", cancel, { once: true });
    rl.once("line", (answer) => finish(answer));
    rl.once("close", () => finish(undefined, new SetupCancelled()));
    output.write(question);
  });
}

/** Streams are injectable; fixtures never read the user's real terminal. */
export function defaultSetupIo(input: TerminalInput = process.stdin, output: TerminalOutput = process.stdout): SetupIo {
  const log = (line: string) => { output.write(`${displayText(line, true)}\n`); };
  const rich = () => output.isTTY === true && process.env.TERM !== "dumb" && process.env.NO_COLOR === undefined
    && (output.columns ?? 80) >= 30 && (output.rows ?? 24) >= 8;

  const run = <T>(prompt: (context: PromptContext) => Promise<T | symbol>): Promise<T> => {
    if (!input.isTTY || !input.setRawMode) throw new Error("Setup needs an interactive terminal.");
    const raw = input.isRaw === true;
    const flowing = input.readableFlowing === true;
    const controller = new AbortController();
    // Clack owns this prompt's readline/key decoder, not the shared stdin.
    // Discarding this stream also discards unfinished escape/paste sequences.
    const promptInput = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: (mode: boolean) => input.setRawMode!(mode),
    });
    let failure: Error | undefined;
    let settled = false;
    const fail = (error: Error) => {
      failure ??= error;
      controller.abort(failure);
    };
    const cancel = () => fail(new SetupCancelled());
    const forward = (chunk: Buffer | string) => {
      // Ctrl-D and cancellation during an incomplete escape must not wait
      // for a key decoder. No prompt input is ever copied to its output.
      const interrupted = typeof chunk === "string"
        ? chunk.includes("\u0003") || chunk.includes("\u0004")
        : chunk.includes(3) || chunk.includes(4);
      if (interrupted) cancel();
      else if (!controller.signal.aborted) promptInput.write(chunk);
    };
    const restore = () => {
      input.setRawMode!(raw);
      if (flowing) input.resume();
      else input.pause();
    };
    return (async () => {
      input.on("data", forward);
      input.once("end", cancel);
      input.once("close", cancel);
      input.once("error", fail);
      output.once("error", fail);
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      process.once("exit", restore);
      try {
        if (input.readableEnded || input.destroyed) throw new SetupCancelled();
        const pending = prompt({ input: promptInput, output, signal: controller.signal });
        input.resume();
        const value = await pending;
        settled = true;
        if (failure) throw failure;
        if (isCancel(value)) throw new SetupCancelled();
        return value as T;
      } catch (error) {
        if (!settled) controller.abort(error);
        throw failure ?? error;
      } finally {
        input.removeListener("data", forward);
        input.removeListener("end", cancel);
        input.removeListener("close", cancel);
        input.removeListener("error", fail);
        output.removeListener("error", fail);
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
        process.removeListener("exit", restore);
        promptInput.destroy();
        restore();
      }
    })();
  };

  const ask: SetupIo["ask"] = (question) => run((context) => rich()
    ? text({ ...context, message: displayText(question) })
    : plainText(displayText(question), false, context));
  const secret: SetupIo["secret"] = (question) => run((context) => rich()
    ? password({ ...context, message: displayText(question), mask: "*" })
    : plainText(displayText(question), true, context));

  const choose: SetupIo["choose"] = async (question, options, defaultIndex = 0) => {
    if (!options.length) throw new Error("There are no choices available.");
    if (!Number.isInteger(defaultIndex) || defaultIndex < 0 || defaultIndex >= options.length) {
      throw new Error("The default choice is not available.");
    }
    if (rich()) return run((context) => select({
      ...context,
      message: displayText(question),
      options: options.map((label, value) => ({ value, label: displayText(label) })),
      initialValue: defaultIndex,
      maxItems: 7,
    }));

    const pageSize = 20;
    let start = Math.floor(defaultIndex / pageSize) * pageSize;
    for (;;) {
      log(question);
      options.slice(start, start + pageSize).forEach((label, offset) => {
        const index = start + offset;
        log(`  ${index + 1}. ${label}${index === defaultIndex ? " (default)" : ""}`);
      });
      const paged = options.length > pageSize;
      if (paged) log(`Showing ${start + 1}–${Math.min(start + pageSize, options.length)} of ${options.length}. Type n/p for next/previous page.`);
      const answer = (await ask(`Choose 1–${options.length} [${defaultIndex + 1}]: `)).trim();
      if (!answer) return defaultIndex;
      if (paged && /^[np]$/i.test(answer)) {
        start = Math.max(0, Math.min(Math.floor((options.length - 1) / pageSize) * pageSize, start + (answer.toLowerCase() === "n" ? pageSize : -pageSize)));
        continue;
      }
      if (/^\d+$/.test(answer) && Number(answer) >= 1 && Number(answer) <= options.length) return Number(answer) - 1;
      log(`Enter a number from 1 to ${options.length}.`);
    }
  };
  const confirm: SetupIo["confirm"] = async (question, defaultYes = false) => {
    if (rich()) return run((context) => clackConfirm({ ...context, message: displayText(question), initialValue: defaultYes }));
    for (;;) {
      const answer = (await ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}: `)).trim();
      if (!answer) return defaultYes;
      if (/^y(es)?$/i.test(answer)) return true;
      if (/^n(o)?$/i.test(answer)) return false;
      log("Enter yes or no.");
    }
  };
  return { log, ask, secret, choose, confirm };
}

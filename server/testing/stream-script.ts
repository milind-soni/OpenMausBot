// A scripted reply for the provider fakes, chosen by a marker in the prompt: words, thinking, a tool call, or a failure,
// streamed a few characters at a time so a chat can be watched while it grows.
//   FAKE_STREAM_SCRIPT   JSON file: { "<marker in the prompt>": StreamStep[] }
//   FAKE_STREAM_CADENCE  "chars:ms" (default 4:40)
import { readFileSync } from "node:fs";

export type StreamStep =
  | { say: string }
  | { think: string }
  | { tool: string }
  | { fail: string };

export interface StreamScript {
  steps: StreamStep[];
  chars: number;
  ms: number;
}

export function streamScript(prompt: string): StreamScript | null {
  const path = process.env.FAKE_STREAM_SCRIPT;
  if (!path) return null;
  let scripts: Record<string, StreamStep[]>;
  try {
    scripts = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  // A prompt can carry earlier requests as context: the newest marker in it is the request.
  const marker = Object.keys(scripts).filter((key) => prompt.includes(key)).sort((a, b) => prompt.lastIndexOf(b) - prompt.lastIndexOf(a) || b.length - a.length)[0];
  if (!marker) return null;
  const [chars = 4, ms = 40] = (process.env.FAKE_STREAM_CADENCE ?? "4:40").split(":").map(Number);
  return { steps: scripts[marker]!, chars: Math.max(1, chars), ms: Math.max(0, ms) };
}

export function streamChunks(text: string, chars: number): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += chars) out.push(text.slice(at, at + chars));
  return out;
}

/** Plays `steps` in order, one chunk every `ms`, until `cancelled()`; `done` runs once at the end unless cancelled. */
export function playStreamScript(script: StreamScript, play: {
  chunk(step: StreamStep, piece: string): void;
  end(step: StreamStep): void;
  done(failure?: string): void;
  cancelled(): boolean;
}): void {
  const queue = script.steps.slice();
  const next = () => {
    if (play.cancelled()) return;
    const step = queue.shift();
    if (!step) return play.done();
    if ("fail" in step) return play.done(step.fail);
    if ("tool" in step) {
      play.end(step);
      return void setTimeout(next, script.ms);
    }
    const pieces = streamChunks("say" in step ? step.say : step.think, script.chars);
    const send = () => {
      if (play.cancelled()) return;
      const piece = pieces.shift();
      if (piece !== undefined) {
        play.chunk(step, piece);
        return void setTimeout(send, script.ms);
      }
      play.end(step);
      setTimeout(next, script.ms);
    };
    send();
  };
  next();
}

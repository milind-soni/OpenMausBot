// The replies a streamed chat is checked with, one per case, each chosen by its marker in the prompt
// (server/testing/stream-script.ts). Every message carries a token of its own (`T<case>M<n>`) so a check can find
// each message's words in a transcript (a message's last words carry `T<case>M<n>z`), and thinking carries `THINK`
// tokens that must never show as reply text. No token appears twice in a case.
import type { StreamStep } from "./stream-script.ts";

export interface LiveReplyCase {
  name: string;
  marker: string;
  steps: StreamStep[];
  /** What the fixture does while the reply streams. */
  action?: "stop" | "steer" | "reconnect" | "switch";
}

const LONG = Array.from({ length: 5 }, (_, n) =>
  `Paragraph ${n + 1} of the long reply walks through one more step of the plan, with enough words that it wraps across several lines in the chat and keeps streaming for a while before the next one starts.`).join("\n\n");

export const LIVE_REPLY_CASES: LiveReplyCase[] = [
  { name: "short", marker: "#case-short", steps: [{ say: "Hi there, T1M1 here." }] },
  { name: "long", marker: "#case-long", steps: [{ say: `T2M1 opens. ${LONG}\n\nT2M1z closes.` }] },
  { name: "markdown", marker: "#case-markdown", steps: [{ say:
    "# Plan T3M1\n\nIntro paragraph.\n\n## Steps\n\n- first item\n- second item\n  - nested item\n\n1. one\n2. two\n\n| Day | Task |\n| --- | --- |\n| Mon | Gym |\n| Tue | Review |\n\n### Done\n\nThat is T3M1z in full." }] },
  { name: "code", marker: "#case-code", steps: [{ say:
    "T4M1 starts the code.\n\n```ts\nconst week = [\"Mon\", \"Tue\"];\nfor (const day of week) {\n  console.log(day);\n}\n```\n\nThen two in a row:\n\n```sh\nls -la\n```\n```py\nprint(\"hi\")\n```\n\nT4M1z ends." }] },
  { name: "math", marker: "#case-math", steps: [{ say: "T5M1 inline math $a^2 + b^2 = c^2$ and display:\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\nT5M1z done." }] },
  { name: "intl", marker: "#case-intl", steps: [{ say: "T6M1 emoji 🎉🚀👍, 中文测试 日本語のテキスト 한국어, and right to left: مرحبا بالعالم שלום עולם. T6M1z end." }] },
  { name: "link-image", marker: "#case-link", steps: [{ say: "T7M1 see [the docs](https://example.com/docs) and the picture ![a cat](https://example.com/cat.png). T7M1z end." }] },
  { name: "text-tool-text", marker: "#case-tools", steps: [
    { say: "T8M1 looking at the folder first." }, { tool: "ls -la" },
    { say: "T8M2 found three files, reading one." }, { tool: "cat notes.txt" },
    { say: "T8M3 all done, nothing else needed." },
  ] },
  { name: "two-messages", marker: "#case-pair", steps: [{ say: "T9M1 is the first message." }, { say: "T9M2 is the second message." }] },
  { name: "whitespace", marker: "#case-blank", steps: [{ say: "   \n\n  " }, { tool: "ls" }, { say: "T10M1 after a blank message." }] },
  { name: "thinking", marker: "#case-think", steps: [
    { think: "THINK11A weighing the options quietly." }, { say: "T11M1 the answer is yes." },
    { think: "THINK11B checking once more." }, { tool: "ls" }, { say: "T11M2 confirmed." },
  ] },
  { name: "stop", marker: "#case-stop", action: "stop", steps: [{ say: `T12M1 starts a reply that will be stopped. ${LONG}` }] },
  { name: "steer", marker: "#case-steer", action: "steer", steps: [{ say: `T13M1 starts a reply that will be steered. ${LONG}` }] },
  { name: "error", marker: "#case-error", steps: [{ say: "T14M1 got this far." }, { tool: "ls" }, { fail: "API Error: 529 Overloaded. This is a server-side issue, usually temporary." }] },
  { name: "reconnect", marker: "#case-reconnect", action: "reconnect", steps: [{ say: `T15M1 keeps going across a reconnect. ${LONG}` }, { tool: "ls" }, { say: "T15M2 after it." }] },
  { name: "switch", marker: "#case-switch", action: "switch", steps: [{ say: `T16M1 keeps going while you look away. ${LONG}` }, { tool: "ls" }, { say: "T16M2 when you are back." }] },
];

/** The scripts file the fakes read: marker to steps. */
export function liveReplyScripts(cases: readonly LiveReplyCase[] = LIVE_REPLY_CASES): Record<string, StreamStep[]> {
  return Object.fromEntries(cases.map((entry) => [entry.marker, entry.steps]));
}

/** The message tokens a case's words carry, in order. */
export function caseTokens(entry: LiveReplyCase): string[] {
  const tokens: string[] = [];
  for (const step of entry.steps) {
    if (!("say" in step)) continue;
    for (const match of step.say.matchAll(/\bT\d+M\d+z?\b/g)) if (!tokens.includes(match[0])) tokens.push(match[0]);
  }
  return tokens;
}

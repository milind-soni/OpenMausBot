// Every command the CLI prints is a command it accepts: a person pastes them as they are.
import { describe, expect, it } from "vitest";

import { parseArgs } from "./cli.ts";
import { browserSignInLines, formatSessions, pairingBlock } from "./cli-pairing.ts";
import { noRouteLines, reachLines } from "./cli-reach.ts";
import { HEADLESS_VERB_NAMES, usage } from "./cli-usage.ts";

const PLACEHOLDERS: Record<string, string> = {
  "https://…": "https://ind.example.com", "<id>": "a1", ID: "a1", NAME: "kitchen", FILE: "team.yaml", EMAIL: "you@example.com",
  HOST: "ind.example.com", DIR: "/tmp/omb", N: "8800", CODE: "ABCD-EFGH-JKLM", BOT: "Chief", URL: "https://ind.example.com", "…": "",
};

/** Each `openindbot …` a line prints, up to the end of the command (two spaces, a quote, a comma or the line's end). */
function printedCommands(text: string): string[][] {
  const found: string[][] = [];
  for (const line of text.split("\n")) {
    for (const match of line.matchAll(/(?:npx )?openindbot((?: (?!openindbot)[^\s,;()`'"]+)*)/g)) {
      const words = match[1]!.trim().split(/\s+/).filter(Boolean).map((word) => PLACEHOLDERS[word] ?? word.replace(/[.:]$/, "")).filter(Boolean);
      if (words.length && !/[[\]|]/.test(words.join(" "))) found.push(words);
    }
  }
  return found;
}

function accepted(words: string[]): string | null {
  if (HEADLESS_VERB_NAMES.has(words[0]!)) return null;
  const parsed = parseArgs(words, {});
  return "error" in parsed ? parsed.error : null;
}

describe("printed commands", () => {
  const now = Date.parse("2026-11-07T10:00:00");
  const outputs = [
    pairingBlock({ code: "ABCD-EFGH-JKLM", expiresAt: now + 600_000, chatOnly: false, link: "https://ind.example.com/pair#code=ABCD-EFGH-JKLM", prefix: "openindbot", now }),
    pairingBlock({ code: "ABCD-EFGH-JKLM", expiresAt: now + 600_000, chatOnly: false, link: null, localLink: "http://127.0.0.1:8799/pair#code=X", prefix: "openindbot", now }),
    noRouteLines(8799, "openindbot").join("\n"),
    reachLines("public-url", "https://ind.example.com", 8799, "openindbot", { ok: false, kind: "unreachable", reason: "connection refused" }).join("\n"),
    browserSignInLines("http://127.0.0.1:8799/pair#code=X", "X", now),
    formatSessions([{ id: "a1", label: "phone", scopes: ["client"], lastSeenAt: now, expiresAt: now }], now),
  ];

  it("finds the commands in what serve, pair and devices print", () => {
    const commands = outputs.flatMap(printedCommands);
    expect(commands.map((words) => words[0])).toEqual(expect.arrayContaining(["pair", "serve", "status", "devices"]));
    for (const words of commands) expect([words.join(" "), accepted(words)]).toEqual([words.join(" "), null]);
  });

  it("every flag the usage text lists is one its command takes", () => {
    let command: string | null = null;
    const checked: string[] = [];
    for (const line of usage().split("\n")) {
      const head = /^ {2}openindbot ([a-z][a-z-]*)/.exec(line);
      if (head) command = head[1]!;
      else if (!/^ {10,}/.test(line) || /^ {2}openindbot -/.test(line)) command = null;
      if (!command || HEADLESS_VERB_NAMES.has(command) || command === "fleet" || command === "sentinel") continue;
      for (const [flag] of line.matchAll(/--[a-z][a-z-]*/g)) {
        const bare = accepted([command, flag]);
        const valued = accepted([command, flag, flag === "--public-url" ? "https://ind.example.com" : flag === "--port" ? "8800" : flag === "--ttl" ? "24h" : flag === "--phone" ? "ios" : "x"]);
        const unknown = (error: string | null) => error !== null && error.includes("unknown argument");
        expect([command, flag, unknown(bare) && unknown(valued)]).toEqual([command, flag, false]);
        checked.push(`${command} ${flag}`);
      }
    }
    expect(checked).toEqual(expect.arrayContaining(["serve --lan", "serve --public-url", "pair --phone", "pair --ttl"]));
  });

  it("writes commands the way the CLI was started", () => {
    expect(usage("npx openindbot")).toContain("  npx openindbot pair  [--label NAME]");
    expect(noRouteLines(8799, "docker compose exec omb openindbot").join("\n")).toContain("docker compose exec omb openindbot serve --lan");
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BOT_LIMIT_CODE, botsTowardLimit } from "../../shared/bot-limit.ts";
import { createBotLimit, STARTER_BOT_LIMIT } from "./starter-bot-limit.ts";

const SERVER = fileURLToPath(new URL("..", import.meta.url));
const made = (count: number) => Array.from({ length: count }, () => ({}));
const onStarter = (bots: Parameters<typeof botsTowardLimit>[0], starter = true) => createBotLimit({ starter: () => starter, bots: () => bots });

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "testing", "dist"].includes(entry.name) ? [] : sources(path);
    return entry.name.endsWith(".ts") && !/\.test\.|\.d\.ts$/.test(entry.name) ? [path] : [];
  });
}
const calling = (pattern: RegExp) => sources(SERVER).filter((path) => pattern.test(readFileSync(path, "utf8")))
  .map((path) => relative(SERVER, path).split(sep).join("/")).sort();

describe("a Starter Cloud's bots", () => {
  it("is five, in one number", () => {
    expect(STARTER_BOT_LIMIT).toBe(5);
  });

  it("counts every bot but its MausBot, an archived one and one that moved away", () => {
    expect(botsTowardLimit([{}, { defaultBot: {} }, { hidden: true }, { movedTo: { state: "moved" } }, {}])).toBe(2);
  });

  it("makes the fifth and refuses the sixth", () => {
    expect(onStarter(made(4)).refusal()).toBeNull();
    expect(onStarter(made(5)).refusal()).toMatchObject({ code: BOT_LIMIT_CODE });
    expect(onStarter(made(5)).limit()).toBe(5);
  });

  it("leaves the MausBot out of the count", () => {
    expect(onStarter([{ defaultBot: {} }, ...made(4)]).refusal()).toBeNull();
    expect(onStarter([{ defaultBot: {} }, ...made(5)]).refusal()).not.toBeNull();
  });

  it("refuses a group that doesn't fit, whole, and takes one that does", () => {
    expect(onStarter(made(3)).refusal(2)).toBeNull();
    const refused = onStarter(made(3)).refusal(3);
    expect(refused?.error).toBe("This adds 3 bots, and your Starter plan has room for 2 more of its 5. To add them all, upgrade this Cloud.");
  });

  it("still refuses a Cloud already over the limit, in the same words as one at it", () => {
    expect(onStarter(made(9)).refusal()?.error).toBe(onStarter(made(5)).refusal()?.error);
  });

  it("tells a person to upgrade, in words an older app can show as they are", () => {
    expect(onStarter(made(5)).refusal()?.error).toBe("You've reached the 5 bots Starter includes. To create more, upgrade this Cloud.");
  });

  it("tells a bot to explain it to the person, not to retry or work around it", () => {
    const words = onStarter(made(5)).refusal(1, "bot")?.error;
    expect(words).toContain("Explain this to the person");
    expect(words).toContain("upgrade this Cloud");
    expect(words).toContain("Do not retry");
    expect(words).toContain("do not try to work around it");
    expect(onStarter(made(4)).refusal(3, "bot")?.error).toContain("Do not retry");
    expect(onStarter(made(9)).refusal(0, "bot"), "changing the bots it has").toBeNull();
  });

  it("has no limit on any other plan, and follows the plan at each question", () => {
    expect(onStarter(made(50), false).refusal(10)).toBeNull();
    expect(onStarter(made(50), false).limit()).toBeUndefined();
    let starter = true;
    const limit = createBotLimit({ starter: () => starter, bots: () => made(5) });
    expect(limit.refusal()).not.toBeNull();
    starter = false;
    expect(limit.refusal()).toBeNull();
    expect(limit.limit()).toBeUndefined();
  });
});

describe("where a bot gets made", () => {
  // A new caller here decides what a plan's limit means for it, and adds itself to the gated or exempt list in this test.
  it("is only the paths the limit has an answer for", () => {
    expect(calling(/\.createBot\(/)).toEqual([
      "default-bot.ts", // a place's MausBot: never counted
      "package-import.ts", // gated before its first record: file imports, templates, the move importer, the org library
      "routes/bots-create.ts", // gated, unless the bot arrives with its own id: a move
      "store.ts", // the store's own seed on an empty place
      "team-backup.ts", // a restore: never refused
    ]);
    expect(calling(/\.applyTeamSetup\(/)).toEqual(["team-setup-requests.ts"]);
  });

  it("gates each of them with the one check", () => {
    const read = (file: string) => readFileSync(join(SERVER, file), "utf8");
    expect(read("routes/bots-create.ts")).toContain("kept.id ? null : deps.botLimit.refusal()");
    expect(read("package-import.ts")).toContain("deps.botLimit?.refusal(members.length)");
    expect(read("team-setup-requests.ts")).toContain("this.options.botLimit?.refusal(creating,");
  });
});

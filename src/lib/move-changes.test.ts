import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moveChanges, type MoveFacts, type MoveLending } from "../../shared/move-changes.ts";
import { setLocale } from "@/lib/i18n";
import en from "@/locales/en.json";
import { hasBotsHere, moveChangeText, namedList } from "./move-changes";

beforeEach(() => { setLocale("en"); });
afterEach(() => { setLocale("en"); });

const none: MoveFacts = { folder: null, folders: 0, engine: null, tools: [], skills: [], hidden: [], teammates: [] };
const off: MoveLending = { paused: false, folderLent: false, terminal: false, together: "unavailable" };
const say = (facts: Partial<MoveFacts>, lending: Partial<MoveLending> = {}, choice = { folder: false, commands: false, together: false }) => {
  const all = { ...none, ...facts };
  return moveChanges(all, { ...off, ...lending }, choice).map((line) => moveChangeText(line, all));
};

describe("the move step's lines, in words", () => {
  it("says each one in one short sentence", () => {
    expect(say({ teammates: ["Reviewer"] })).toEqual(["Reviewer stays on this computer, so work can't be handed to it from My Cloud."]);
    expect(say({ teammates: ["Proofreader", "Reviewer"] })).toEqual(["Proofreader and Reviewer stay on this computer, so work can't be handed to them from My Cloud."]);
    // With This computer and My Cloud together on, no claim either way about hand-offs.
    expect(say({ teammates: ["Reviewer"] }, { together: "on" })).toEqual(["Reviewer stays on this computer."]);
    expect(say({ teammates: ["Proofreader", "Reviewer"] }, { together: "on" })).toEqual(["Proofreader and Reviewer stay on this computer."]);
    expect(say({ folder: "~/code/app", folders: 1 }, { folderLent: true, terminal: true })).toEqual(["~/code/app stays on this computer; My Cloud reaches it while this computer is on."]);
    expect(say({ folder: "~/code/app", folders: 1 }, { terminal: true })).toEqual(["~/code/app stays on this computer, out of My Cloud's reach."]);
    expect(say({ folder: "~/code/app", folders: 1 }, { paused: true })[0]).toBe("~/code/app stays on this computer; lending to My Cloud is paused, so it can't reach it.");
    expect(say({ folder: "~/a", folders: 3 }, { folderLent: true, terminal: true })).toEqual(["3 folders, such as ~/a, stay on this computer; My Cloud reaches them while this computer is on."]);
    expect(say({ folder: "~", folders: 1 }, { folderLent: true, terminal: true })).toEqual(["Your home folder stays on this computer; My Cloud reaches it while this computer is on."]);
    expect(say({ engine: "Ollama" })).toEqual(["Ollama runs on this computer; on My Cloud, My Cloud's model takes its place."]);
    expect(say({ tools: ["git"] })).toEqual(["My Cloud can't run commands on this computer, so git won't work there."]);
    expect(say({ folder: "~/a", folders: 1 }, { folderLent: true })[1]).toBe("My Cloud can't run commands on this computer.");
    expect(say({ skills: ["weekly-digest"], hidden: ["~/.claude"] })).toEqual(["weekly-digest reads ~/.claude on this computer, which lending never opens, so it won't work there."]);
    expect(say({ skills: ["logs", "recap"], hidden: ["~/.claude", "~/.codex"] })).toEqual(["logs and recap read ~/.claude and ~/.codex on this computer, which lending never opens, so they won't work there."]);
  });

  it("names three at most and counts the rest", () => {
    expect(namedList(["A", "B", "C"])).toBe("A, B, and C");
    expect(namedList(["A", "B", "C", "D", "E"])).toBe("A, B, C, and 2 more");
  });

  it("has every line, choice and the offer's line in every language the app ships, with the same placeholders", () => {
    const keys = Object.keys(en).filter((key) => key.startsWith("cloudSend.changes.") || key === "cloudSend.botMove.goes" || key === "cloudSend.botMove.commandsFailed" || key === "cloudBuy.onePlace") as Array<keyof typeof en>;
    expect(keys.length).toBeGreaterThan(25);
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort();
    const dir = new URL("../locales/", import.meta.url);
    const packs = readdirSync(dir).filter((file) => file.endsWith(".json") && file !== "en.json" && file !== "source-hashes.json");
    expect(packs.length).toBe(15);
    for (const file of packs) {
      const pack = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Record<string, string>;
      for (const key of keys) {
        expect(pack[key], `${file} ${key}`).toBeTruthy();
        expect(holes(pack[key]!), `${file} ${key}`).toEqual(holes(en[key]));
      }
    }
    setLocale("pt-br");
    expect(say({ engine: "Ollama" })).toEqual(["Ollama roda neste computador; no My Cloud, o modelo do My Cloud fica no lugar dele."]);
  });
});

describe("who the Cloud's offer says a bot lives in one place to", () => {
  const mine = { bots: [{ defaultBot: false }], cloudHome: false, desktop: true, remote: false };
  it("someone on this computer's page with bots of their own", () => {
    expect(hasBotsHere(mine)).toBe(true);
  });
  it("nobody else: only the starter, bots that moved or live elsewhere, My Cloud's page, another server's, or a browser", () => {
    expect(hasBotsHere({ ...mine, bots: [{ defaultBot: true }] })).toBe(false);
    expect(hasBotsHere({ ...mine, bots: [{ movedTo: { state: "moved" } }, { home: { place: "cloud" } }, { hidden: true }] })).toBe(false);
    expect(hasBotsHere({ ...mine, cloudHome: true })).toBe(false);
    expect(hasBotsHere({ ...mine, remote: true })).toBe(false);
    expect(hasBotsHere({ ...mine, desktop: false })).toBe(false);
  });
});

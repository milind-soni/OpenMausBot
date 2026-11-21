import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { moveMemoryRoute, type MoveMemoryDeps } from "./cloud-send-memory.ts";
import { DATA_DIR } from "./config.ts";
import { learnedState, planLearned } from "./profile-learned.ts";

const path = join(DATA_DIR, "profile-learned.json");
const deps: MoveMemoryDeps = {
  bot: () => undefined,
  teamMemory: { list: () => [], adopt: () => 0 },
  aboutMe: () => "",
  saveAboutMe: () => { throw new Error("a removal-only move must not add About me lines"); },
  owner: () => ({ email: "owner@example.test" }) as never,
};

beforeEach(() => { mkdirSync(DATA_DIR, { recursive: true }); });

async function receive(removed: string[]) {
  let answer: { status: number; body: unknown } | undefined;
  await moveMemoryRoute(deps, {
    path: "/api/cloud-send/memory", method: "POST", url: new URL("http://localhost/api/cloud-send/memory"),
    req: {}, res: { setHeader() {} }, auth: {},
    readBody: async () => ({ v: 1, about: { learned: [], removed } }),
    json: (_res: unknown, status: number, body: unknown) => { answer = { status, body }; },
  } as never);
  expect(answer).toMatchObject({ status: 200, body: { about: 0, failed: [] } });
}

it("keeps a newly moved removal when the stored removal history is already full", async () => {
  const old = Array.from({ length: 500 }, (_, i) => `Old fact ${i}`);
  writeFileSync(path, JSON.stringify({ learned: [], removed: old }));
  await receive(["Prefers phone calls"]);

  // Planning reopens the file, as a later bot turn or restarted server would.
  expect(planLearned({ botId: "bot", botName: "Nova" }, ["Prefers phone calls"], "", "2026-11-21")).toEqual([]);
  expect(learnedState().removed).toEqual([...old.slice(1), "Prefers phone calls"]);
  const once = readFileSync(path, "utf8");
  await receive(["Prefers phone calls"]);
  expect(readFileSync(path, "utf8")).toBe(once);
});

it("retains local removals and forget passages when receiving duplicate removals", async () => {
  const state = { learned: [], removed: ["Prefers phone calls"], forgotten: ["acme"] };
  writeFileSync(path, JSON.stringify(state));
  await receive(["Prefers phone calls"]);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(state);
  expect(planLearned({ botId: "bot", botName: "Nova" }, ["Works at Acme", "Prefers phone calls"], "", "2026-11-21")).toEqual([]);
});

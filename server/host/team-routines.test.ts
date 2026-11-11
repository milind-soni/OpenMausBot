import { describe, expect, it } from "vitest";

import { RESULTS_JUST_ME } from "../../shared/routines.ts";
import { CLOUD_NOBODY_KEY, CLOUD_OUTSIDE_KEY } from "../cloud-sharing.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Routine } from "../routines.ts";
import { createTeamRoutines, type TeamRoutinesDeps } from "./team-routines.ts";

const BOB = "bob@acme.test", bob = personKey({ id: "", email: BOB });
const OLIVE = "olive@acme.test", olive = personKey({ id: "", email: OLIVE });
const session = (email: string) => ({ kind: "session", scopes: ["client"], session: { id: `s-${email}`, email } }) as unknown as RequestAuth;

function fixture(team = true) {
  const starters = new Map<string, string>([["bob-chat", bob], ["bob-old-results", bob]]);
  const tasks = [
    { threadId: "main", title: "Scout" },
    { threadId: "bob-old-results", title: "Standup · Results" },
    { threadId: "bob-chat", title: "Bob's plans" },
  ];
  const writers = new Map<string, string>();
  const opened: Array<[string, string, string]> = [];
  const deps: TeamRoutinesDeps = {
    team,
    privateTo: (threadId) => starters.get(threadId) ?? null,
    task: (_botId, threadId) => tasks.find((task) => task.threadId === threadId),
    ownBot: (botId) => (botId === "bobs-mausbot" ? bob : null),
    routines: () => null,
    authors: { forget: () => {}, wrote: (id, person) => { writers.set(id, person); }, writer: (id) => writers.get(id), remove: () => {} },
    withWriter: (_writer, work) => work(),
    tasks: () => tasks,
    openChat: (botId, title, person) => { opened.push([botId, title, person]); starters.set("new-chat", person); return "new-chat"; },
    threadRefusal: () => "On this Cloud you can only change conversations you started.",
  };
  return { host: createTeamRoutines(deps), writers, opened, tasks };
}
const routine = (fields: Partial<Routine>) => ({ id: "r1", name: "Standup", botId: "scout", ...fields }) as Routine;

describe("createTeamRoutines", () => {
  it("opens a shared routine's chats as the team, whoever wrote it, and a private one's as its person", () => {
    const { host, writers } = fixture();
    writers.set("r1", bob);
    expect(host.opener(routine({}))).toBe(CLOUD_NOBODY_KEY);
    expect(host.opener(routine({ resultsThreadId: "main" }))).toBe(CLOUD_NOBODY_KEY);
    expect(host.opener(routine({ sourceThreadId: "bob-chat" }))).toBe(bob);
    expect(host.opener(routine({ botId: "bobs-mausbot" }))).toBe(bob);
    writers.set("r1", CLOUD_OUTSIDE_KEY);
    expect(host.opener(routine({}))).toBe(CLOUD_OUTSIDE_KEY);
    expect(fixture(false).host.opener(routine({}))).toBeNull();
  });

  it("moves results that sit outside where the routine lives, a shared one's old private results chat included", () => {
    const { host } = fixture();
    expect(host.reportsElsewhere(routine({ resultsThreadId: "bob-old-results" })), "a shared routine, its writer's old chat").toBe(true);
    expect(host.reportsElsewhere(routine({ resultsThreadId: "main" }))).toBe(false);
    expect(host.reportsElsewhere(routine({ sourceThreadId: "bob-chat", resultsThreadId: "main" })), "a private one into the shared chat").toBe(true);
    expect(host.reportsElsewhere(routine({ resultsThreadId: "bob-chat" }))).toBe(false);
    expect(fixture(false).host.reportsElsewhere(routine({ resultsThreadId: "bob-old-results" }))).toBe(false);
  });

  it("lets a member point results at any chat they read, refuses another person's MausBot, and keeps the Cloud's rule off a team", () => {
    const { host } = fixture();
    expect(host.bodyRefusal(session(BOB), { botId: "scout", resultsThreadId: "main" })).toBeNull();
    expect(host.bodyRefusal(session(OLIVE), { botId: "bobs-mausbot", name: "x" })).toEqual({ status: 404, error: "no such bot" });
    expect(host.bodyRefusal(session(BOB), { botId: "bobs-mausbot", name: "x" })).toBeNull();
    expect(fixture(false).host.bodyRefusal(session(BOB), { resultsThreadId: "main" })?.status).toBe(403);
  });

  it("makes Just me the person's own private chat with the bot, or a new one", () => {
    const { host, opened, tasks } = fixture();
    expect(host.justMe(session(BOB), { botId: "scout", name: "Kumquat", resultsThreadId: RESULTS_JUST_ME })).toMatchObject({ resultsThreadId: "bob-chat" });
    expect(host.justMe(session(OLIVE), { botId: "scout", name: "Kumquat", resultsThreadId: RESULTS_JUST_ME })).toMatchObject({ resultsThreadId: "new-chat" });
    expect(opened).toEqual([["scout", "Kumquat", olive]]);
    tasks.splice(2, 1);
    expect(host.justMe(session(BOB), { botId: "scout", name: "Standup", resultsThreadId: RESULTS_JUST_ME }), "never the chat a routine opened for itself").toMatchObject({ resultsThreadId: "new-chat" });
    const plain = { botId: "scout", resultsThreadId: "main" };
    expect(host.justMe(session(BOB), plain)).toBe(plain);
  });

  it("makes a new routine that names no audience its writer's alone, and widens nothing the person did not choose", () => {
    const { host, opened } = fixture();
    expect(host.justMe(session(BOB), { botId: "scout", name: "Kumquat" }), "nothing said: his own chat").toMatchObject({ resultsThreadId: "bob-chat" });
    expect(host.justMe(session(OLIVE), { botId: "scout", name: "Kumquat", target: "bot" })).toMatchObject({ resultsThreadId: "new-chat" });
    expect(opened).toEqual([["scout", "Kumquat", olive]]);
    // The person's own choice still stands: the shared chat by id, and an older app's null.
    const shared = { botId: "scout", name: "Standup", resultsThreadId: "main" }, older = { botId: "scout", name: "Standup", resultsThreadId: null };
    expect(host.justMe(session(BOB), shared)).toBe(shared);
    expect(host.justMe(session(BOB), older)).toBe(older);
    // A change to an existing routine that names no audience moves nothing.
    const change = { name: "Renamed" };
    expect(host.justMe(session(BOB), change, "r1")).toBe(change);
    // Their own MausBot's are theirs already; a group chat's goal has the group chat's audience.
    const own = { botId: "bobs-mausbot", name: "Morning note" }, goal = { botId: "scout", groupId: "room", target: "room-goal", name: "Goal" };
    expect(host.justMe(session(BOB), own)).toBe(own);
    expect(host.justMe(session(BOB), goal)).toBe(goal);
    // No session (the server's own work) and anywhere off a team: as it was.
    const unsaid = { botId: "scout", name: "Kumquat" };
    expect(host.justMe({ kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth, unsaid)).toBe(unsaid);
    expect(fixture(false).host.justMe(session(BOB), unsaid)).toBe(unsaid);
  });

  it("never falls back to the shared place when no private chat can be opened", () => {
    const starters = new Map<string, string>();
    const host = createTeamRoutines({ team: true, privateTo: (threadId) => starters.get(threadId) ?? null, task: () => undefined, routines: () => null, authors: null,
      withWriter: (_writer, work) => work(), tasks: () => [], openChat: () => undefined, threadRefusal: () => null });
    expect(host.justMe(session(BOB), { botId: "scout", name: "Kumquat" })).toMatchObject({ resultsThreadId: RESULTS_JUST_ME });
  });
});

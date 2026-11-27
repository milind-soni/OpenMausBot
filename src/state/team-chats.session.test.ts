import { afterEach, expect, it, vi } from "vitest";

vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useEffect: (effect: () => void) => { effect(); } }));
vi.mock("./api", () => ({ api: vi.fn() }));

import { readSessionState } from "@/lib/session";
import { setTeamChats, teamChats, useTeamChats } from "./team-chats";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const session = (scopes: string[], openedThreads: string[]) => ({ kind: "session", id: "s1", label: "Ben's Mac", scopes, expiresAt: 9, team: { id: "team-acme", name: "Acme", role: "admin" }, openedThreads });
afterEach(() => { setTeamChats(null); vi.unstubAllGlobals(); });

it("a team session says which conversations its person opened, and the sidebar's rule keeps them, on any device", async () => {
  const answer = session(["admin", "client"], ["ben-1", "ben-2"]);
  const fetched = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));
  expect(await readSessionState(fetched as never)).toMatchObject({ kind: "session", team: { id: "team-acme" }, openedThreads: ["ben-1", "ben-2"] });
  vi.stubGlobal("fetch", fetched);
  useTeamChats({ team: { id: "team-acme" } });
  await flush();
  expect(teamChats()).toEqual({ teamId: "team-acme", member: false, opened: ["ben-1", "ben-2"] });
  const { openedThreads: _none, ...plain } = answer;
  expect(await readSessionState((async () => new Response(JSON.stringify({ ...plain, team: undefined }), { status: 200 })) as never)).not.toHaveProperty("openedThreads");
});

import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudSendNotice, CloudSendPageBridge } from "../../electron/cloud-send.mjs";
import type { TeamMoveView } from "../../electron/team-move.mjs";
import { installTeamMove } from "../../electron/team-move-main.mjs";
import { ipcErrorText } from "@/lib/cloud-send";
import { setLocale } from "@/lib/i18n";
import type { Bot } from "@/state/store";
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = initial; return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("react-dom", async original => ({ ...await original<typeof import("react-dom")>(), createPortal: (node: ReactNode) => node }));
import { CloudSendStrip } from "./CloudSendStrip";
import { MovedBotRows, TeamMoveLine, useMoveToTeam } from "./MoveToTeam";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; disabled?: boolean }>;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deep = (value: ReactNode): Node[] => {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(deep)];
};
const text = (node: Node): string => Children.toArray(node.props.children).map((child) => isValidElement(child) ? text(child as Node) : String(child)).join("");
const html = (component: () => ReactNode) => { f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(component)).replaceAll("&#x27;", "'"); };
const tree = (component: () => ReactNode) => { f.index = 0; f.effects = []; return deep(component()); };
const button = (component: () => ReactNode, label: string) => tree(component).find((node) => node.type === "button" && text(node) === label);

const ACME = { id: "team-acme", name: "Acme" };
const SCOUT = { id: "scout", name: "Scout", threadId: "scout-main", hidden: false } as Bot;
const notice: CloudSendNotice = { ready: true, bots: [], updatedBots: [], skills: 0, logins: 0, onePassword: false, settings: 0, signature: "", dismissed: false, running: false, last: null, whole: null };
let page: CloudSendPageBridge & Required<Pick<CloudSendPageBridge, "teams" | "moveToTeam" | "teamRetry" | "openTeam">>;

beforeEach(() => {
  f.values = []; f.index = 0; f.effects = []; setLocale("en");
  page = {
    notice: vi.fn().mockResolvedValue(notice), dismiss: vi.fn().mockResolvedValue(notice), onNotice: vi.fn(() => () => {}),
    teams: vi.fn().mockResolvedValue({ teams: [{ ...ACME, ready: true }, { id: "team-beta", name: "Beta", ready: false }] }),
    moveToTeam: vi.fn().mockResolvedValue(null), teamRetry: vi.fn().mockResolvedValue({ bot: SCOUT, team: ACME, phase: "moving" }), openTeam: vi.fn().mockResolvedValue(undefined),
  };
  vi.stubGlobal("window", { ogb: { cloudSendPage: page }, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("document", { body: {}, activeElement: null });
});
afterEach(() => { vi.unstubAllGlobals(); });

const line = (move: TeamMoveView, onChange = vi.fn()) => () => TeamMoveLine({ move, onChange });

it("says how the move goes on My Cloud's page: on its way with nothing to press, failed with Try again, done with Open it there", async () => {
  const moving: TeamMoveView = { bot: { id: "scout", name: "Scout" }, team: ACME, phase: "moving" };
  expect(html(line(moving))).toContain("Moving Scout to Acme…");
  expect(tree(line(moving)).some((node) => node.type === "button")).toBe(false);
  const failed = { ...moving, phase: "failed" as const };
  expect(html(line(failed))).toContain("Couldn't move Scout. It's still here, unchanged.");
  const changed = vi.fn();
  button(line(failed, changed), "Try again")!.props.onClick!(); await flush();
  expect(page.teamRetry).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledWith({ bot: SCOUT, team: ACME, phase: "moving" });
  const done = { ...moving, phase: "done" as const };
  expect(html(line(done))).toContain("Scout is in Acme now, with your chats.");
  button(line(done), "Open Scout in Acme")!.props.onClick!();
  expect(page.openTeam).toHaveBeenCalledWith("team-acme");
  button(line(done, changed), "Close")!.props.onClick!(); await flush();
  expect(page.dismiss).toHaveBeenCalledWith("team-move");
  expect(changed).toHaveBeenLastCalledWith(null);
});

it("the strip shows a bot's move into a team on My Cloud's page only", async () => {
  const value = { ...notice, teamMove: { bot: { id: "scout", name: "Scout" }, team: ACME, phase: "moving" as const } };
  page.notice = vi.fn().mockResolvedValue(value);
  const strip = (cloudHome: boolean) => () => CloudSendStrip({ cloudHome });
  html(strip(true)); for (const effect of f.effects) effect(); await flush();
  expect(html(strip(true))).toContain("Moving Scout to Acme…");
  expect(html(strip(false))).toBe("");
});

it("a moved bot leaves one line that opens it in the team; a moving or archived one leaves none", () => {
  const bots = [{ ...SCOUT, hidden: true, movedTo: { team: ACME, state: "moved", at: 1 } }, { ...SCOUT, id: "quill", name: "Quill", movedTo: { team: ACME, state: "moving", at: 1 } }, { ...SCOUT, id: "old", name: "Old", hidden: true }] as Bot[];
  const rows = () => MovedBotRows({ bots });
  expect(html(rows)).toContain("Scout moved to Acme");
  expect(html(rows)).not.toContain("Quill");
  expect(html(rows)).not.toContain("Old");
  button(rows, "Scout moved to Acme")!.props.onClick!();
  expect(page.openTeam).toHaveBeenCalledWith("team-acme");
  expect(html(() => MovedBotRows({ bots: [SCOUT] }))).toBe("");
});

it("the bot menu has one Move to item per team, none without a team or for a bot already moving; the confirm says what goes and what stays", async () => {
  let blocked: string | undefined;
  const items: Array<{ label: string; onClick?: () => void; opts?: { disabled?: boolean; hint?: string } }> = [];
  const item = (_icon: ReactNode, label: string, onClick?: () => void, opts?: { disabled?: boolean; hint?: string }) => { items.push({ label, onClick, opts }); return null; };
  let hook!: ReturnType<typeof useMoveToTeam>;
  const menu = () => { hook = useMoveToTeam({ blocked: () => blocked }); return hook.dialog; };
  html(menu); for (const effect of f.effects) effect(); await flush();
  html(menu);
  hook.items(SCOUT, item);
  expect(items.map((entry) => [entry.label, entry.opts?.disabled])).toEqual([["Move to Acme", false], ["Move to Beta", true]]);
  items.length = 0;
  hook.items({ ...SCOUT, movedTo: { team: ACME, state: "moving", at: 1 } } as Bot, item);
  expect(items).toEqual([]);
  blocked = "Your Chief of Staff stays on My Cloud";
  hook.items(SCOUT, item);
  expect(items[0]!.opts).toEqual({ disabled: true, hint: blocked });
  blocked = undefined;
  items.length = 0;
  hook.items(SCOUT, item);
  items[0]!.onClick!();
  const confirm = html(menu);
  for (const said of ["Move Scout to Acme?", "Only you and Acme's admins can use Scout until you share it.",
    "Goes with Scout: instructions, skills, files, routines, and your chats with Scout", "Your chats stay private there: only you can see them.",
    "Stays on My Cloud: what Scout remembers, your connections, and MausBot", "There's no way back: you can't move it back to My Cloud.", "Move to Acme"]) expect(confirm).toContain(said);
  expect(page.moveToTeam, "nothing moves until the confirm").not.toHaveBeenCalled();
});

it("Move to Acme in the confirm asks main to move the bot, with a real click; nothing moves without one", async () => {
  const items: Array<{ onClick?: () => void }> = [];
  const menu = () => useMoveToTeam({ blocked: () => undefined });
  f.index = 0; let hook = menu(); for (const effect of f.effects) effect(); await flush();
  f.index = 0; hook = menu();
  hook.items(SCOUT, (_icon, _label, onClick) => { items.push({ onClick }); return null; });
  items[0]!.onClick!();
  f.index = 0; hook = menu();
  const props = (hook.dialog as ReactElement<{ open: boolean; onConfirm(): void }>).props;
  expect(props.open).toBe(true);
  props.onConfirm(); await flush();
  expect(page.moveToTeam).toHaveBeenCalledWith("scout", "team-acme", "Scout");
  f.index = 0; hook = menu();
  expect((hook.dialog as ReactElement<{ open: boolean }>).props.open, "closed once main took it").toBe(false);
});

function newMain() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let journal: unknown = { v: 1, moves: [{ bot: { id: "scout", name: "Scout" }, team: { id: "team-acme", name: "Acme" }, phase: "copy", startedAt: 1 }] };
  const team = (id: string, name: string) => ({ id, name, machine: { origin: `https://${id}.example.test`, status: "ready" } });
  installTeamMove({
    ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); } }, cloudPage: () => "cloud", home: () => null,
    account: () => ({ state: () => ({ status: "connected", teams: [team("team-acme", "Acme"), team("team-beta", "Beta")] }), pairTeam: () => Promise.reject(new Error("offline")) }),
    file: () => "/nonexistent/cloud-send.json", journalFile: () => "/nonexistent/team-moves.json", journal: { read: () => journal, write: (value) => { journal = value; } },
  });
  // Electron 43: ipcRenderer.invoke rejects with this text and the toString() of what main threw.
  const invoke = async (channel: string, ...args: unknown[]) => {
    try { return await handlers.get(channel)!({}, ...args); } catch (error) { throw new Error(`Error invoking remote method '${channel}': ${error}`); }
  };
  return {
    moveToTeam: (bot: string, teamId: string, name: string) => invoke("cloud-send:team-move", bot, teamId, name) as ReturnType<NonNullable<CloudSendPageBridge["moveToTeam"]>>,
    moveToTeamCoded: (bot: string, teamId: string, name: string) => invoke("cloud-send:team-move-coded", bot, teamId, name) as ReturnType<NonNullable<CloudSendPageBridge["moveToTeamCoded"]>>,
  };
}

async function confirmMove(teamIndex = 0) {
  f.values = []; f.effects = [];
  const items: Array<{ onClick?: () => void }> = [];
  const menu = () => useMoveToTeam({ blocked: () => undefined });
  f.index = 0; let hook = menu(); for (const effect of f.effects) effect(); await flush();
  f.index = 0; hook = menu();
  hook.items(SCOUT, (_icon, _label, onClick) => { items.push({ onClick }); return null; });
  items[teamIndex]!.onClick!();
  f.index = 0; hook = menu();
  (hook.dialog as ReactElement<{ onConfirm(): void }>).props.onConfirm(); await flush();
  f.index = 0;
  return { html: renderToStaticMarkup(menu().dialog as ReactElement).replaceAll("&#x27;", "'"), open: (menu().dialog as ReactElement<{ open: boolean }>).props.open };
}

it("a new main refusing a page that predates the coded bridge: the plain English, read as before", async () => {
  const main = newMain();
  const said = async (teamId: string) => main.moveToTeam("scout", teamId, "Scout").then(() => null, ipcErrorText);
  expect(await said("team-gone")).toBe("You're not in that team.");
  expect(await said("team-beta")).toBe("Scout is moving to Acme.");
  expect(await main.moveToTeam("../x", "team-acme", "Scout").then(() => null, ipcErrorText)).toBe("Choose one of your bots to move.");
});

it("a new main and a new page: the refusal in the page's language, main's English for a code the page doesn't know", async () => {
  const main = newMain();
  setLocale("pt-br");
  page.moveToTeam = vi.fn(main.moveToTeam);
  page.moveToTeamCoded = vi.fn(main.moveToTeamCoded);
  page.teams = vi.fn().mockResolvedValue({ teams: [{ id: "team-beta", name: "Beta", ready: true }] });
  expect((await confirmMove()).html).toContain("Scout está indo para Acme.");
  expect(page.moveToTeam).not.toHaveBeenCalled();
  page.teams = vi.fn().mockResolvedValue({ teams: [{ id: "team-gone", name: "Gone", ready: true }] });
  expect((await confirmMove()).html).toContain("Você não está nessa equipe.");
  page.moveToTeamCoded = vi.fn().mockResolvedValue({ refused: { code: "movingElsewhere", params: { bot: "Scout" }, message: "Scout is moving to Acme." } });
  expect((await confirmMove()).html, "a name it needs is missing").toContain("Scout is moving to Acme.");
  expect((await confirmMove()).html).not.toContain("{team}");
  for (const code of ["somethingNew", "toString"]) {
    page.moveToTeamCoded = vi.fn().mockResolvedValue({ refused: { code, params: {}, message: "Acme is full." } });
    expect((await confirmMove()).html, code).toContain("Acme is full.");
  }
  page.moveToTeamCoded = vi.fn().mockResolvedValue({ view: null });
  expect((await confirmMove()).open, "closed once main took it").toBe(false);
});

it("a new page and an older main without the coded bridge: main's English", async () => {
  setLocale("pt-br");
  page.moveToTeam = vi.fn().mockRejectedValue(new Error("Error invoking remote method 'cloud-send:team-move': Error: You're not in that team."));
  expect(page.moveToTeamCoded).toBeUndefined();
  expect((await confirmMove()).html).toContain("You're not in that team.");
});

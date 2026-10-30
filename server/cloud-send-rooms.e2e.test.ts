// The rooms a one-time move carries, end to end: this computer's server and a Cloud home
// (scripts/testing/cloud-send-fixture.ts) with main's own wiring between them. Every shape of room a person has: one with
// history, one nobody wrote in yet, one whose bots were all deleted here, and one removed on My Cloud after an older
// send carried it. Then the check, which must agree with what was meant to go. Disposable homes; no network.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

let fx: CloudSendFixture;

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-rooms-${randomBytes(8).toString("hex")}` });
}, hostTimeout(90_000));
afterAll(async () => {
  await fx?.close();
});

type Side = CloudSendFixture["local"];
type Room = { id: string; threadId: string };
const newBot = async (name: string) => (await fx.local("POST", "/api/bots", { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot as { id: string; threadId: string };
const newRoom = async (name: string, memberIds: string[]) =>
  (await fx.local("POST", "/api/groups", { name, memberIds, setup: { bulletin: `${name} notes.`, defaultResponder: { kind: "mentions" } } })).body.group as Room;
const note = async (room: Room, text: string) => expect((await fx.local("POST", `/api/groups/${room.id}/messages`, { text, threadId: room.threadId })).status).toBeLessThan(300);
const rooms = async (side: Side) => ((await side("GET", "/api/bots?messages=0")).body.groups as Array<{ id: string; name: string; memberIds: string[]; bulletin: string; dm?: boolean }>)
  .filter((room) => !room.dm);
const roomIds = async (side: Side) => (await rooms(side)).map((room) => room.id);

it("a move carries every room that can go, one nobody wrote in yet too, and its check leaves out the rooms that cannot", async () => {
  const { local, onCloud } = fx;
  const ada = await newBot("Ada");
  expect((await local("PATCH", `/api/bots/${ada.id}`, { soul: "You are Ada." })).status).toBe(200);
  // An older app's whole Send carried this room; then the person removed it on My Cloud.
  const gone = await newRoom("Gone", [ada.id]);
  await note(gone, "An old plan.");
  expect((await fx.olderSend()).result.bots).toContain("Ada");
  expect(await roomIds(onCloud)).toContain(gone.id);
  expect((await onCloud("DELETE", `/api/groups/${gone.id}`)).status).toBe(200);
  // Written in here since: that goes, and My Cloud answers that the room was removed there.
  await note(gone, "A newer plan.");

  const launch = await newRoom("Launch", [ada.id]);
  await note(launch, "Ship on Friday.");
  // Nobody wrote in it yet, as a room a team setup or a package made, with a bot that lives only there.
  const bo = await newBot("Bo");
  const quiet = await newRoom("Quiet", [ada.id, bo.id]);
  const dot = await newBot("Dot");
  const team = await newRoom("Team", [dot.id]);
  // Its only bot was deleted here: the room stays, with its history, and no bot of it goes.
  const cleo = await newBot("Cleo");
  const orphan = await newRoom("Orphan", [cleo.id]);
  await note(orphan, "Cleo's notes.");
  expect((await local("DELETE", `/api/bots/${cleo.id}`)).status).toBeLessThan(300);

  await fx.move();
  await fx.move({ final: true });
  const report = await fx.check();
  expect(report.gaps?.rooms, "every room that can go is there").toEqual([]);
  expect(report.gaps?.conversations).toEqual([]);
  expect(report.chats.filter((entry) => entry.missing || entry.unstamped || entry.path === "broken")).toEqual([]);
  expect(report.ok).toBe(true);
  const there = await roomIds(onCloud);
  expect(there).toEqual(expect.arrayContaining([launch.id, quiet.id, team.id]));
  expect(there, "removed on My Cloud stays removed; a room with no bot that goes is never made").not.toContain(gone.id);
  expect(there).not.toContain(orphan.id);
  const made = (await rooms(onCloud)).find((room) => room.id === quiet.id)!;
  expect(made).toMatchObject({ name: "Quiet", bulletin: "Quiet notes." });
  expect(made.memberIds.sort()).toEqual([ada.id, bo.id].sort());

  // A move run again finds nothing more to do for them, and the check still passes.
  await fx.move({ final: true });
  expect((await fx.check()).ok).toBe(true);
}, hostTimeout(180_000));

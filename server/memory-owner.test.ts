import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createAboutMe } from "./about-me.ts";
import { ownersOwnLine } from "./cloud-owner-lines.ts";
import type { CaptureTurn } from "./memory-capture.ts";
import { botMemoryUpdate, ownersOwnAsk } from "./memory-forget.ts";
import { personKey } from "./person-key.ts";
import { isForgotten } from "./profile-learned.ts";
import type { Message } from "./store.ts";
import { workspaceDir } from "./workspace.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const OWNER = { name: "Owner", id: personKey({ id: "local-owner" }) };
const OTHER = { name: "Owner", id: personKey({ id: "other-device" }) };
const user = (sender?: Message["sender"]): Message => ({ id: "ask", at: 1, role: "user", kind: "text", text: "I prefer early meetings.", ...(sender ? { sender } : {}) });
const reply: Message = { id: "reply", at: 3, role: "bot", kind: "text", text: "Noted.", turnId: "turn", from: { botId: "memo", name: "Memo", color: "blue" } };

function capture(name: "captureTurnFor" | "captureRoomTurnFor", path: Message[]): CaptureTurn | null {
  const declaration = source.match(new RegExp(`function ${name}\\([\\s\\S]*?^}`, "m"))![0];
  const run = new Function("store", "extractTurnImages", "ownersOwnLine", "ROOM_CAPTURE_LINES",
    `${stripTypeScriptTypes(declaration)}; return ${name};`)({ activePath: () => path }, (text: string) => ({ text }), ownersOwnLine, 40);
  return name === "captureTurnFor" ? run("thread", "turn") : run("thread", "memo", "turn");
}

it.each([undefined, OWNER, OTHER])("direct capture recognizes only the local owner's sender: %j", sender => {
  expect(capture("captureTurnFor", [user(sender), reply])).toMatchObject({ person: "I prefer early meetings.", owner: sender !== OTHER });
});

it.each([undefined, OWNER, OTHER])("room capture preserves each speaker's attribution: %j", sender => {
  const owner = sender !== OTHER;
  expect(capture("captureRoomTurnFor", [user(sender), reply])).toMatchObject({
    person: owner ? "I prefer early meetings." : "", owner, room: [{ by: owner ? "person" : "other" }],
  });
});

it("keeps a bare API room line separate from the owner", () => {
  const asked: Message = { ...user(), via: "api" };
  expect(capture("captureRoomTurnFor", [asked, reply])).toMatchObject({ person: "", owner: false, room: [{ by: "other" }] });
});

it("keeps other speakers separate when a room also contains the verified owner", () => {
  const other = { ...user(OTHER), id: "other", at: 2, text: "I prefer late meetings." };
  expect(capture("captureRoomTurnFor", [user(OWNER), other, reply])).toMatchObject({
    person: "I prefer early meetings.", owner: false, room: [{ by: "person" }, { by: "other" }],
  });
});

it.each([OWNER, OTHER])("forget removes About me and records the passage only for the owner: %j", sender => {
  const owner = sender === OWNER;
  const passage = owner ? "paper maps" : "wooden desks";
  const fact = `I prefer ${passage}.`;
  const layer = owner ? "owner-forget" : "other-forget";
  mkdirSync(workspaceDir(layer), { recursive: true });
  writeFileSync(join(workspaceDir(layer), "MEMORY.md"), `${fact}\nI avoid peanuts.\n`);
  let profile = `${fact}\nI avoid peanuts.`;
  const aboutMe = createAboutMe({ read: () => profile, write: text => { profile = text; }, changed: () => {}, today: () => "2026-11-09" });
  const result = botMemoryUpdate(layer, { action: "forget", oldText: passage }, { source: "chat", aboutMe: ownersOwnAsk([user(sender)]) ? aboutMe : null });
  expect(result).toMatchObject({ ok: true, forgotten: [fact], aboutMe: owner ? [fact] : [] });
  expect(profile.includes(fact)).toBe(!owner);
  expect(profile).toContain("I avoid peanuts.");
  expect(isForgotten(fact)).toBe(owner);
});

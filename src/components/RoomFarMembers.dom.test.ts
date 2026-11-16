// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { nextMemberIds } from "@/lib/room-members";
import { RoomFarMembers, farMembersOf } from "./RoomFarMembers";

let container: HTMLDivElement, root: Root;
const rows = () => [...document.body.querySelectorAll<HTMLElement>("[data-far-member]")];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const far = [
  { id: "link-0000abcd-atlas", name: "Atlas", place: "My Cloud", state: "ok" as const },
  { id: "link-0000abcd-nova", name: "Nova", place: "My Cloud", state: "off" as const },
  { id: "link-0000abcd-scout", name: "Scout", place: "My Cloud", state: "missing" as const },
];

it("a room with no member from another place draws nothing", async () => {
  await act(async () => root.render(createElement(RoomFarMembers, { members: farMembersOf({ memberIds: ["writer"] }), picked: new Set(["writer"]), onToggle: () => {} })));
  expect(document.body.querySelector("[data-testid=room-far-members]")).toBeNull();
});

it("each member from another place is listed with where it lives and why it cannot answer, and can be unticked", async () => {
  const group = { memberIds: ["writer", far[0].id, far[1].id, far[2].id], farMembers: [...far, { id: "link-0000abcd-left", name: "Left", place: "My Cloud", state: "ok" as const }] };
  const picked = new Set(group.memberIds), toggled: string[] = [];
  const draw = () => act(async () => root.render(createElement(RoomFarMembers, { members: farMembersOf(group), picked: new Set(picked), onToggle: (id: string) => { toggled.push(id); if (!picked.delete(id)) picked.add(id); } })));
  await draw();
  // One the server still lists but the room no longer has is not drawn.
  expect(rows().map((row) => [row.dataset.farMember, row.dataset.farState, row.getAttribute("aria-checked"), row.textContent])).toEqual([
    [far[0].id, "ok", "true", "Atlason My Cloud"],
    [far[1].id, "off", "true", "Novaon My Cloud · Link is off"],
    [far[2].id, "missing", "true", "Scouton My Cloud · No longer available"],
  ]);
  await act(async () => rows()[2]!.click());
  await draw();
  expect(toggled).toEqual([far[2].id]);
  expect(rows()[2]!.getAttribute("aria-checked")).toBe("false");
  // What the panel then saves: the member the person unticked is gone, the others stay as they were.
  expect(nextMemberIds(group.memberIds, picked, ["writer"])).toEqual(["writer", far[0].id, far[1].id]);
});

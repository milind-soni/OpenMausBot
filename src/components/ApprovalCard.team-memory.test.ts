import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ admin: false as boolean | null }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));

const { ApprovalCard } = await import("./ApprovalCard");

const saved: Message = {
  id: "applied-card", role: "bot", kind: "options", at: 1,
  card: {
    title: "Remember", subtitle: "Person: Ada Lovelace — Runs the payroll review.", options: [], answered: "allow", dismissed: true,
    autoApplied: true, requestId: "memory-request", tool: "propose_team_memory",
    teamMemoryRequest: { section: "", entryId: "e", kind: "person", revision: "v1" },
  },
};
const render = () => renderToStaticMarkup(createElement(ApprovalCard, { bot: { name: "Luna" }, message: saved, threadId: "thread-1" }));

beforeEach(() => { fixture.admin = false; });

it("offers no Undo on a department memory notice to a session that may not review team memory", () => {
  const html = render();
  expect(html).toContain("Luna saved to department memory: Person: Ada Lovelace");
  expect(html).not.toContain(">Undo<");
});

it("keeps Undo for an admin", () => {
  fixture.admin = true;
  expect(render()).toContain(">Undo<");
});

import { describe, expect, it } from "vitest";

import {
  hasAgentCapability,
  isSourceOperator,
  normalizeAgentGrants,
  resolveAgentGrants,
  selectNotificationMirrorDestination,
  syncCoordinatorRole,
} from "./agent-capabilities.ts";

describe("agent capabilities", () => {
  it("migrates the legacy coordinator flag without looking at a display name", () => {
    const grants = normalizeAgentGrants({ chiefOfStaff: true });
    expect(grants.map((grant) => grant.capability)).toEqual([
      "agents.coordinate",
      "source.memory.read",
      "source.memory.tombstone",
      "world.model.read",
    ]);
    expect(hasAgentCapability({ chiefOfStaff: true, name: "anything" }, "agents.coordinate")).toBe(true);
  });

  it("migrates the reviewed collector package once, while allowing any bot name", () => {
    const input = {
      name: "Notebook",
      installedPackage: { id: "shane-grok-capture-replica" },
      playbooks: [{ key: "capture-protocol" }],
    };
    expect(isSourceOperator(input)).toBe(true);
    expect(hasAgentCapability(input, "source.memory.write")).toBe(true);
    expect(hasAgentCapability({ ...input, name: "Capture" }, "source.memory.write")).toBe(true);
  });

  it("treats explicit grants as authoritative and drops malformed values", () => {
    const grants = resolveAgentGrants({
      chiefOfStaff: true,
      installedPackage: { id: "shane-grok-capture-replica" },
      playbooks: [{ key: "capture-protocol" }],
      agentGrants: [
        { capability: "source.memory.read" },
        { capability: "source.memory.read" },
        { capability: "not-a-capability" },
        null,
      ],
    });
    expect(grants).toEqual([{ capability: "source.memory.read" }]);
    expect(isSourceOperator({ agentGrants: [] })).toBe(false);
  });

  it("adds and removes coordination without stripping independent source grants", () => {
    const grants = syncCoordinatorRole({
      agentGrants: [{ capability: "source.ingestion" }, { capability: "source.memory.write" }],
    }, true);
    expect(grants.map((grant) => grant.capability)).toEqual([
      "source.ingestion",
      "source.memory.write",
      "agents.coordinate",
      "source.memory.read",
      "source.memory.tombstone",
      "world.model.read",
    ]);
    expect(syncCoordinatorRole({ agentGrants: grants }, false)).toEqual([
      { capability: "source.ingestion" },
      { capability: "source.memory.write" },
    ]);
  });

  it("routes notification events to a capability owner, regardless of display name", () => {
    const destination = selectNotificationMirrorDestination([
      { id: "first", name: "Chief", chiefOfStaff: true },
      { id: "second", name: "Inbox worker", agentGrants: [{ capability: "source.memory.write" }] },
    ]);
    expect(destination?.id).toBe("second");
    expect(selectNotificationMirrorDestination([
      { id: "renamed", name: "Anything", agentGrants: [{ capability: "agents.coordinate" }] },
    ])).toBeNull();
  });
});

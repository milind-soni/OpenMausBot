import { describe, expect, it } from "vitest";

import { resolveCapabilityTurnOwner } from "./capability-turn-router.ts";

function gateway(...tokens: string[]) {
  const owned = new Set(tokens);
  return { ownsTurn: (token: string) => owned.has(token) };
}

describe("capability turn owner resolution", () => {
  it("selects the sole full-task or observer owner", () => {
    const fullTask = gateway("full");
    const observer = gateway("observer");

    expect(resolveCapabilityTurnOwner("full", fullTask, observer)).toMatchObject({
      status: "owned",
      owner: "full-task",
      gateway: fullTask,
    });
    expect(resolveCapabilityTurnOwner("observer", fullTask, observer)).toMatchObject({
      status: "owned",
      owner: "observer",
      gateway: observer,
    });
  });

  it("fails closed when no gateway or both gateways own the token", () => {
    expect(resolveCapabilityTurnOwner("missing", gateway(), gateway())).toEqual({ status: "none" });
    expect(resolveCapabilityTurnOwner("collision", gateway("collision"), gateway("collision"))).toEqual({
      status: "ambiguous",
    });
  });
});

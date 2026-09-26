import { expect, it } from "vitest";
import { FIXTURE_STARTER_BOT_NAME, launchVerificationServer } from "../scripts/control-omb.ts";

it("pins the fixture starter bot's name deterministically (#1257)", async () => {
  // The first-run seed draws a random name from server/names.ts — "Quill" is
  // in that pool — so a suite planning a bot named like the starter could
  // flake on a name-based assertion. Two launches must both see exactly one
  // starter with the pinned name, whatever the pool drew.
  for (let launch = 0; launch < 2; launch++) {
    const fixture = await launchVerificationServer({});
    try {
      const response = await fetch(fixture.info.url + "/api/bots", {
        headers: { origin: fixture.info.url },
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.ok).toBe(true);
      const bots = ((await response.json()) as { bots: Array<{ name: string }> }).bots;
      expect(bots).toHaveLength(1);
      expect(bots[0].name).toBe(FIXTURE_STARTER_BOT_NAME);
    } finally {
      await fixture.close();
    }
  }
});

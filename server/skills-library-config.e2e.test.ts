import { describe, expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

describe("skills library config visibility", () => {
  it("returns the saved opt-in flag to the actual settings client", async () => {
    const fixture = await launchVerificationServer();
    const api = async (method: string, body?: unknown) => {
      const response = await fetch(`${fixture.info.url}/api/config`, {
        method,
        headers: { "content-type": "application/json", origin: fixture.info.url },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as { features: { skillsLibrary?: boolean } } };
    };
    try {
      expect((await api("GET")).body.features.skillsLibrary).toBe(false);
      const saved = await api("PATCH", { features: { skillsLibrary: true } });
      expect(saved.status).toBe(200);
      expect(saved.body.features.skillsLibrary).toBe(true);
      expect((await api("GET")).body.features.skillsLibrary).toBe(true);
      expect((await api("PATCH", { features: { skillsLibrary: false } })).body.features.skillsLibrary).toBe(false);
      console.info(JSON.stringify(fixture.info));
    } finally {
      await fixture.close();
    }
  });
});

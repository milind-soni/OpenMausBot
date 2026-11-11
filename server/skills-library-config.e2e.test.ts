import { describe, expect, it } from "vitest";
import { featureConfigSchema, type FeatureStatus } from "../shared/features.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";

describe("skills library config visibility", () => {
  it("reports every feature and preserves partial settings across restart", async () => {
    const fixture = await launchRestartableServer();
    const api = async (method: string, body?: unknown) => {
      const response = await fetch(`${fixture.url}/api/config`, {
        method,
        headers: { "content-type": "application/json", origin: fixture.url },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as { features: FeatureStatus } };
    };
    try {
      const initial = await api("GET");
      expect(initial.status).toBe(200);
      expect(Object.keys(initial.body.features).sort()).toEqual([...Object.keys(featureConfigSchema.shape), "savedStepsHere"].sort());
      expect(initial.body.features.skillsLibrary).toBe(false);
      const configured = await api("PATCH", { features: { autoRecall: false, skillReviewSteps: 23, shareLearnedSkills: "auto" } });
      expect(configured.status).toBe(200);
      const saved = await api("PATCH", { features: { skillsLibrary: true } });
      expect(saved.status).toBe(200);
      expect(saved.body.features.skillsLibrary).toBe(true);
      expect((await api("GET")).body.features.skillsLibrary).toBe(true);
      expect(saved.body.features).toEqual({ ...configured.body.features, skillsLibrary: true, shareLearnedSkills: "auto" });
      await fixture.stop();
      await fixture.start();
      expect((await api("GET")).body.features).toEqual(saved.body.features);
      const disabled = await api("PATCH", { features: { skillsLibrary: false } });
      expect(disabled.status).toBe(200);
      expect(disabled.body.features).toMatchObject({ skillsLibrary: false, autoRecall: false, skillReviewSteps: 23, shareLearnedSkills: "off" });
      expect((await api("PATCH", { features: { skillsLibrary: true } })).body.features.shareLearnedSkills).toBe("auto");
      console.info(JSON.stringify({ url: fixture.url, dataDir: fixture.dataDir, logPath: fixture.logPath }));
    } finally {
      await fixture.close();
    }
  });
});

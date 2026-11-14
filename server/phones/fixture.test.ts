import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { isPhoneToolName } from "../../shared/phone-apps.ts";
import { phoneJobOutcome } from "./jobs.ts";
import { phoneRegistration } from "./registry.ts";
import { PHONE_TOOLS, phoneToolCallProblem } from "./tools.ts";

const fixture = JSON.parse(readFileSync(new URL("../testing/fixtures/phone-jobs.json", import.meta.url), "utf8"));

describe("phone-jobs.json contract fixture", () => {
  it("has a valid registration", () => {
    expect(phoneRegistration.safeParse(fixture.registration).success).toBe(true);
  });

  it("has valid outcomes", () => {
    for (const outcome of fixture.outcomes) expect(phoneJobOutcome.safeParse(outcome).success).toBe(true);
  });

  it("has device.job frames", () => {
    expect(fixture.frames.length).toBeGreaterThan(0);
    for (const frame of fixture.frames) {
      expect(frame).toEqual({ kind: "device.job", phone: expect.any(String), id: expect.any(String) });
    }
  });

  it("has well-formed jobs", () => {
    expect(fixture.jobs.length).toBeGreaterThan(0);
    for (const job of fixture.jobs) {
      expect(typeof job.id).toBe("string");
      expect(isPhoneToolName(job.tool)).toBe(true);
      expect(phoneToolCallProblem(job.tool, job.arguments)).toBeNull();
      expect(typeof job.expiresAt).toBe("number");
    }
  });

  it("has a register response matching the registration", () => {
    expect(fixture.registerResponse.phone.registration).toEqual(fixture.registration);
    expect(Object.keys(fixture.registerResponse.phone)).toEqual(["key", "registration", "registeredAt", "seen", "lastUsedAt", "online", "busy"]);
  });

  it("lists exactly the server's PHONE_TOOLS", () => {
    expect(fixture.toolsList.tools).toEqual(PHONE_TOOLS);
  });
});

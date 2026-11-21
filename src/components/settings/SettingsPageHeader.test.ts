// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { appVersion } from "@/lib/app-links";
import { overviewStatus } from "./SettingsPageHeader";

beforeEach(() => {
  setLocale("en");
  (window as unknown as { ogb: unknown }).ogb = { app: { version: "9.8.7", ownPage: false } };
});

afterEach(() => {
  delete (window as unknown as { ogb?: unknown }).ogb;
});

describe("overviewStatus on a Cloud's page in the desktop window", () => {
  it("names the desktop app's version for This computer", () => {
    expect(overviewStatus({ name: "This computer", kind: "computer", color: null, named: false })).toContain("9.8.7");
  });

  it("names the page's own version for the Cloud", () => {
    const line = overviewStatus({ name: "My Cloud", kind: "cloud", color: null, named: false });
    expect(line).toContain(appVersion());
    expect(line).not.toContain("9.8.7");
  });
});

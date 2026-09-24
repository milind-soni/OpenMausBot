import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConfigStatus } from "@/state/store";
import { LicenseExpiryBanner, licenseNotice } from "./LicenseExpiryBanner";

const config = (license?: NonNullable<ConfigStatus["edition"]>["license"]): ConfigStatus =>
  ({ edition: { edition: "enterprise", features: ["budgets"], ...(license ? { license } : {}) } }) as ConfigStatus;

describe("license expiry banner", () => {
  it("is silent unless the server sends the dates (admins, inside the warning window or grace)", () => {
    expect(licenseNotice(null)).toBeNull();
    expect(licenseNotice(config())).toBeNull();
    expect(licenseNotice({ edition: { edition: "oss", features: [] } } as unknown as ConfigStatus)).toBeNull();
    expect(renderToStaticMarkup(createElement(LicenseExpiryBanner, { config: config() }))).toBe("");
  });

  it("warns before expiry and says when features stop during the grace period", () => {
    expect(licenseNotice(config({ expiresAt: "2027-01-01", expiresInDays: 12 }))).toEqual({
      tone: "warning",
      text: "This workspace's enterprise license expires on 2027-01-01 (12 day(s) left). Renew the key to keep enterprise features.",
    });
    const grace = licenseNotice(config({ expiresAt: "2027-01-01", expiresInDays: -2, graceEndsAt: "2027-01-08" }));
    expect(grace).toEqual({
      tone: "danger",
      text: "This workspace's enterprise license expired on 2027-01-01. Enterprise features keep working until 2027-01-08; renew the key before then.",
    });
    const html = renderToStaticMarkup(createElement(LicenseExpiryBanner, { config: config({ expiresAt: "2027-01-01", expiresInDays: 3 }) }));
    expect(html).toContain('role="status"');
    expect(html).toContain("expires on 2027-01-01 (3 day(s) left)");
  });
});

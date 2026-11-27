import { describe, expect, it } from "vitest";

import { APP_SITES, appForSite } from "./app-sites.ts";
import { loginSite } from "./logins.ts";

describe("the app a sign-in site belongs to", () => {
  it.each([
    ["github.com", "github"],
    ["https://github.com/login?return_to=%2F", "github"],
    ["GITHUB.COM", "github"],
    ["www.notion.so", "notion"],
    ["acme.atlassian.net", "jira"],
    ["app.linear.app", "linear"],
    ["x.com", "twitter"],
  ])("%s is %s", (site, slug) => {
    expect(appForSite(site)).toBe(slug);
  });

  it.each([
    "github.com.example.net",
    "evil-github.com",
    "githubusercontent.com",
    "notgithub.com",
    "accounts.google.com",
    "login.microsoftonline.com",
    "example.com",
    "",
    "javascript:alert(1)",
    "http://[::1]/",
  ])("%s offers no app", (site) => {
    expect(appForSite(site)).toBeNull();
  });

  it("lists registrable domains only, so a match is never on a subdomain or a public suffix", () => {
    for (const domain of Object.keys(APP_SITES)) expect(loginSite(domain)).toBe(domain);
  });

  it("ignores missing input", () => {
    expect(appForSite(null)).toBeNull();
    expect(appForSite(undefined)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { loginLabel, loginMatchesHost, loginOriginCheck, loginPageCheck, loginPlace, loginSite, loginUsableBy, normalizeLoginHost, savedLoginResumePrompt } from "./logins.ts";

describe("a login's host", () => {
  it.each([
    ["accounts.example.com", "accounts.example.com"],
    ["https://Accounts.Example.com/login?next=/", "accounts.example.com"],
    ["www.example.com", "www.example.com"],
    ["http://localhost:3000/sign-in", "localhost"],
    ["  example.com  ", "example.com"],
    ["https://example.com./login", "example.com"],
  ])("reads %s as %s", (raw, host) => {
    expect(normalizeLoginHost(raw)).toBe(host);
  });

  it.each(["", "example", "javascript:alert(1)", "file:///etc/passwd", "https://user:pw@example.com/", "ftp://example.com", "exa mple.com", 42])(
    "refuses %s", (raw) => {
      expect(normalizeLoginHost(raw)).toBeNull();
    });
});

describe("a login's site", () => {
  it.each([
    ["accounts.example.com", "example.com"],
    ["www.example.com", "example.com"],
    ["Login.Example.COM.", "example.com"],
    ["a.b.example.co.uk", "example.co.uk"],
    ["login.microsoftonline.com", "microsoftonline.com"],
    ["alice.github.io", "alice.github.io"],
    ["docs.alice.github.io", "alice.github.io"],
    ["my-app.vercel.app", "my-app.vercel.app"],
    ["github.io", "github.io"],
    ["localhost", "localhost"],
    ["127.0.0.1", "127.0.0.1"],
    ["[::1]", "[::1]"],
  ])("of %s is %s", (host, site) => {
    expect(loginSite(host)).toBe(site);
  });
});

describe("where a login fills", () => {
  const example = loginPlace("example.com");

  it("fills anywhere on its site, on the sign-in hosts saved with it, and nowhere else", () => {
    for (const host of ["example.com", "accounts.example.com", "www.example.com", "a.b.example.com", "EXAMPLE.com."]) expect(loginMatchesHost(example, host), host).toBe(true);
    for (const host of ["example.com.evil.test", "myexample.com", "example.co.uk", "example.org"]) expect(loginMatchesHost(example, host), host).toBe(false);
    const sso = loginPlace("example.com", ["example.com", "login.microsoftonline.com"]);
    expect(loginMatchesHost(sso, "login.microsoftonline.com")).toBe(true);
    expect(loginMatchesHost(sso, "evil.microsoftonline.com")).toBe(false);
  });

  it("never offers one github.io name's login on another", () => {
    const alice = loginPlace("alice.github.io");
    expect(loginMatchesHost(alice, "alice.github.io")).toBe(true);
    expect(loginMatchesHost(alice, "docs.alice.github.io")).toBe(true);
    expect(loginMatchesHost(alice, "bob.github.io")).toBe(false);
    expect(loginMatchesHost(alice, "github.io")).toBe(false);
  });

  it("keeps a login marked for its exact host to its hosts", () => {
    const acme = loginPlace("acme.okta.com", [], true);
    expect(acme).toEqual({ site: "okta.com", hosts: ["acme.okta.com"], exactHost: true });
    expect(loginMatchesHost(acme, "acme.okta.com")).toBe(true);
    expect(loginMatchesHost(acme, "evil.okta.com")).toBe(false);
    expect(loginMatchesHost({ ...acme, exactHost: false }, "evil.okta.com")).toBe(true);
  });

  it("names the site for the bot, or the hosts when it is kept to them", () => {
    expect(loginLabel({ ...loginPlace("accounts.example.com"), username: "alice" })).toBe("example.com (alice)");
    expect(loginLabel({ ...loginPlace("acme.okta.com", [], true), username: "" })).toBe("acme.okta.com");
  });
});

describe("the page check", () => {
  it("passes https, and plain http only on this computer", () => {
    expect(loginPageCheck("https://EXAMPLE.com:8443/login")).toEqual({ ok: true, pageHost: "example.com" });
    expect(loginPageCheck("http://localhost:3000/").ok).toBe(true);
    expect(loginPageCheck("http://127.0.0.1:8080/").ok).toBe(true);
    expect(loginPageCheck("http://example.com/")).toMatchObject({ ok: false, reason: "insecure" });
    expect(loginPageCheck("javascript:alert(1)")).toMatchObject({ ok: false, reason: "address" });
    expect(loginPageCheck("not a url")).toMatchObject({ ok: false, reason: "address" });
  });

  it("adds the login's own hosts", () => {
    expect(loginOriginCheck("https://accounts.example.com/", loginPlace("example.com"))).toEqual({ ok: true, pageHost: "accounts.example.com" });
    expect(loginOriginCheck("https://example.com.evil.test/", loginPlace("example.com"))).toMatchObject({ ok: false, reason: "host" });
    expect(loginOriginCheck("http://example.com/", loginPlace("example.com"))).toMatchObject({ ok: false, reason: "insecure" });
  });
});

describe("who may use a login", () => {
  it("is every bot, or the ones named", () => {
    expect(loginUsableBy({ bots: "all" }, "pepper")).toBe(true);
    expect(loginUsableBy({ bots: ["pepper"] }, "pepper")).toBe(true);
    expect(loginUsableBy({ bots: ["pepper"] }, "quill")).toBe(false);
  });
});

it("tells a resumed bot fill_login submits for it, never to ask for the password", () => {
  const prompt = savedLoginResumePrompt("example.com");
  expect(prompt).toContain("saved a login for example.com");
  expect(prompt).toContain("call fill_login there: it fills the form and submits it.");
  expect(prompt).toContain("Never ask for a password or a one-time code in chat.");
});

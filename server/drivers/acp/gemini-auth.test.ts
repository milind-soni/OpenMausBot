// #28: the Gemini driver's credential detection after the 2026-06-18
// consumer OAuth shutdown. The shared setup already points HOME at a
// throwaway directory, so these tests write ~/.gemini/oauth_creds.json
// there and assert what the exported check reports for each shape.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { geminiIsAuthenticated } from "./gemini.ts";

const geminiDir = join(homedir(), ".gemini");
const credsPath = join(geminiDir, "oauth_creds.json");

const writeCreds = (creds: unknown) => {
  mkdirSync(geminiDir, { recursive: true });
  writeFileSync(credsPath, JSON.stringify(creds));
};

describe("gemini auth detection (#28)", () => {
  afterEach(() => {
    rmSync(geminiDir, { recursive: true, force: true });
  });

  it("counts an API key with no oauth file present", () => {
    expect(geminiIsAuthenticated({ GEMINI_API_KEY: "AIza..." })).toBe(true);
    expect(geminiIsAuthenticated({ GOOGLE_API_KEY: "AIza..." })).toBe(true);
  });

  it("rejects blank API keys", () => {
    expect(geminiIsAuthenticated({ GEMINI_API_KEY: "  ", GOOGLE_API_KEY: "\t" })).toBe(false);
  });

  it("reads as signed out with no key and no credential file", () => {
    expect(geminiIsAuthenticated({})).toBe(false);
  });

  it("counts an unexpired access token", () => {
    writeCreds({ access_token: "at", expiry_date: Date.now() + 60_000 });
    expect(geminiIsAuthenticated({})).toBe(true);
  });

  it("keeps an expired token alive only when a refresh token exists (enterprise path)", () => {
    writeCreds({ access_token: "at", expiry_date: Date.now() - 60_000 });
    expect(geminiIsAuthenticated({})).toBe(false);
    writeCreds({ access_token: "at", refresh_token: "rt", expiry_date: Date.now() - 60_000 });
    expect(geminiIsAuthenticated({})).toBe(true);
  });

  it("reads the common post-shutdown consumer shape — expired, no refresh — as signed out", () => {
    writeCreds({ access_token: "at", expiry_date: Date.now() - 86_400_000 });
    expect(geminiIsAuthenticated({})).toBe(false);
  });

  it("treats a corrupt or unreadable credential file as signed out, not a crash", () => {
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(credsPath, "{not json");
    expect(geminiIsAuthenticated({})).toBe(false);
  });

  it("counts a credential with no recorded expiry", () => {
    writeCreds({ access_token: "at" });
    expect(geminiIsAuthenticated({})).toBe(true);
  });

  it("rejects blank token strings and an invalid expiry", () => {
    writeCreds({ access_token: "  ", expiry_date: Date.now() + 60_000 });
    expect(geminiIsAuthenticated({})).toBe(false);
    writeCreds({ access_token: "at", refresh_token: " \t", expiry_date: Date.now() - 60_000 });
    expect(geminiIsAuthenticated({})).toBe(false);
    writeCreds({ access_token: "at", expiry_date: "soon" });
    expect(geminiIsAuthenticated({})).toBe(false);
    writeCreds({ access_token: "at", expiry_date: Number.POSITIVE_INFINITY });
    expect(geminiIsAuthenticated({})).toBe(false);
  });
});

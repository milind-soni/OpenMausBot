import { describe, expect, it } from "vitest";

import englishCatalog from "../src/locales/en.json" with { type: "json" };
import { redactSecretsInText } from "../shared/redact.ts";
import { USER_ERROR, refusalBody, userError, userErrorFields, userErrorThrown } from "./user-errors.ts";

describe("user errors", () => {
  it("the catalog's server errors are exactly the ones the server sends", () => {
    const catalog = Object.fromEntries(Object.entries(englishCatalog).filter(([key]) => key.startsWith("serverError.")));
    expect(catalog).toEqual(USER_ERROR);
  });

  it("fills in the English and keeps the key and params beside it", () => {
    expect(userError("serverError.pair.tooMany", { time: "11:19 UTC" })).toEqual({
      error: "Too many wrong codes. Try again at 11:19 UTC.",
      errorKey: "serverError.pair.tooMany",
      errorParams: { time: "11:19 UTC" },
    });
    expect(userError("serverError.pair.codeWrong")).toEqual({
      error: "pairing code is wrong or has expired; create a new one on the server",
      errorKey: "serverError.pair.codeWrong",
    });
  });

  it("keeps the English the department and page refusals had", () => {
    expect(userError("serverError.department.shareSkillLimit", { count: 64 }).error).toBe("A department can share at most 64 skills. Choose fewer skills and try again.");
    expect(userError("serverError.department.shareSkillClash", { skill: "pricing" }).error)
      .toBe('Two bots in this department have different skills named "pricing". Leave that skill out and try again.');
    expect(userError("serverError.page.versionGone")).toEqual({ error: "That version of the page is no longer kept.", errorKey: "serverError.page.versionGone" });
    expect(refusalBody(userError("serverError.team.noSuchPhone"))).toEqual({ error: "no such phone", errorKey: "serverError.team.noSuchPhone" });
  });

  it("scrubs a secret in a param from both the English and the params, and leaves secret-free words alone", () => {
    const secret = `sk-${"a1B2c3D4".repeat(3)}`;
    const masked = redactSecretsInText(secret);
    expect(masked).not.toContain(secret);
    const said = userError("serverError.chat.busyInRoom", { room: `Launch ${secret}` });
    expect(said).toEqual({ error: `this bot is working in channel Launch ${masked}`, errorKey: "serverError.chat.busyInRoom", errorParams: { room: `Launch ${masked}` } });
    const thrown = userErrorThrown("serverError.email.unavailable", { detail: secret });
    expect(JSON.stringify([thrown.message, { ...thrown }])).not.toContain(secret);
    expect(refusalBody({ error: "x", errorKey: "serverError.team.signInFirst", errorParams: { team: secret } }).errorParams).toEqual({ team: masked });
    expect(userError("serverError.chat.busyInRoom", { room: "Launch" })).toEqual({
      error: "this bot is working in channel Launch", errorKey: "serverError.chat.busyInRoom", errorParams: { room: "Launch" },
    });
    expect(userError("serverError.pair.tooMany", { seconds: 42 }).errorParams).toEqual({ seconds: 42 });
  });

  it("forwards only a key it knows", () => {
    expect(refusalBody({ error: "boom", errorKey: "chat.notice.resumingAfterRestart" })).toEqual({ error: "boom" });
    expect(userErrorFields(new Error("plain"))).toEqual({});
    const thrown = Object.assign(new Error("x"), { errorKey: "serverError.chat.busyInRoom", errorParams: { room: "Launch" } });
    expect(userErrorFields(thrown)).toEqual({ errorKey: "serverError.chat.busyInRoom", errorParams: { room: "Launch" } });
  });
});

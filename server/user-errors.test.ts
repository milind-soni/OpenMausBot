import { describe, expect, it } from "vitest";

import englishCatalog from "../src/locales/en.json" with { type: "json" };
import { USER_ERROR, refusalBody, userError, userErrorFields } from "./user-errors.ts";

describe("user errors", () => {
  it("the catalog's server errors are exactly the ones the server sends", () => {
    const catalog = Object.fromEntries(Object.entries(englishCatalog).filter(([key]) => key.startsWith("serverError.")));
    expect(catalog).toEqual(USER_ERROR);
  });

  it("fills in the English and keeps the key and params beside it", () => {
    expect(userError("serverError.pair.tooMany", { seconds: 42 })).toEqual({
      error: "too many failed pairing attempts from your address; try again in 42s",
      errorKey: "serverError.pair.tooMany",
      errorParams: { seconds: 42 },
    });
    expect(userError("serverError.pair.codeWrong")).toEqual({
      error: "pairing code is wrong or has expired; create a new one on the server",
      errorKey: "serverError.pair.codeWrong",
    });
  });

  it("forwards only a key it knows", () => {
    expect(refusalBody({ error: "boom", errorKey: "chat.notice.answerPassed" })).toEqual({ error: "boom" });
    expect(userErrorFields(new Error("plain"))).toEqual({});
    const thrown = Object.assign(new Error("x"), { errorKey: "serverError.chat.busyInRoom", errorParams: { room: "Launch" } });
    expect(userErrorFields(thrown)).toEqual({ errorKey: "serverError.chat.busyInRoom", errorParams: { room: "Launch" } });
  });
});

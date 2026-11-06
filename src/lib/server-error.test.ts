import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import ptBr from "@/locales/pt-br.json";
import { api, ApiError } from "@/state/api";
import { saveLoginFromCard } from "./logins";
import { pairWithCode, startEmailSignIn } from "./session";
import { serverErrorText } from "./server-error";

const WRONG = "pairing code is wrong or has expired; create a new one on the server";
const respond = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

afterEach(() => {
  setLocale("en");
  vi.unstubAllGlobals();
});

describe("a refusal the server names by key", () => {
  it("is shown in the person's language while the body keeps the English", async () => {
    setLocale("pt-br");
    vi.stubGlobal("fetch", respond(409, { error: "this bot is working in channel Launch", errorKey: "serverError.chat.busyInRoom", errorParams: { room: "Launch" } }));
    const refused = await api("/api/bots/b/interrupt", { method: "POST" }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).message).toBe(ptBr["serverError.chat.busyInRoom"].replace("{room}", "Launch"));
    expect((refused as ApiError).body?.error).toBe("this bot is working in channel Launch");
  });

  it("reaches a member saving a login on a team, where only an admin may", async () => {
    setLocale("pt-br");
    vi.stubGlobal("fetch", respond(403, {
      error: "On Acme only an admin can save a login, and it is then used by every bot in Acme.",
      errorKey: "serverError.team.memberLogin", errorParams: { team: "Acme" },
    }));
    const fields = { username: "me", password: "pw", totp: "" };
    await expect(saveLoginFromCard({ botId: "b", threadId: "t", messageId: "m" }, fields))
      .rejects.toMatchObject({ message: ptBr["serverError.team.memberLogin"].replaceAll("{team}", "Acme") });
  });

  it("says the department and page refusals in pt-BR, and their English exactly where there are no own words", () => {
    const clash = { error: 'Two bots in this department have different skills named "pricing". Leave that skill out and try again.',
      errorKey: "serverError.department.shareSkillClash", errorParams: { skill: "pricing" } };
    const gone = { error: "That version of the page is no longer kept.", errorKey: "serverError.page.versionGone" };
    setLocale("pt-br");
    expect(serverErrorText(clash, clash.error)).toBe("Dois bots desta equipe têm habilidades diferentes chamadas “pricing”. Deixe essa habilidade de fora e tente novamente.");
    expect(serverErrorText(gone, gone.error)).toBe(ptBr["serverError.page.versionGone"]);
    expect(serverErrorText({ ...clash, errorParams: undefined }, clash.error)).toBe(clash.error);
    setLocale("en");
    expect(serverErrorText(clash, clash.error)).toBe(clash.error);
    expect(serverErrorText(gone, gone.error)).toBe(gone.error);
  });

  it("stays English without a key, with a key outside serverError., or with a param missing", () => {
    setLocale("pt-br");
    expect(serverErrorText({ error: "boom" }, "boom")).toBe("boom");
    expect(serverErrorText({ errorKey: "chat.notice.resumingAfterRestart" }, "boom")).toBe("boom");
    expect(serverErrorText({ errorKey: "serverError.inventedLater" }, "boom")).toBe("boom");
    expect(serverErrorText({ errorKey: "serverError.chat.busyInRoom" }, "boom")).toBe("boom");
    expect(serverErrorText({ errorKey: "serverError.chat.busyInRoom", errorParams: { room: { name: "x" } } }, "boom")).toBe("boom");
  });

  it("reaches the pairing page, which does not go through api()", async () => {
    setLocale("pt-br");
    expect(await pairWithCode({ code: "AAAA-BBBB-CCCC", label: "Phone" }, respond(401, { error: WRONG, errorKey: "serverError.pair.codeWrong" })))
      .toEqual({ ok: false, error: ptBr["serverError.pair.codeWrong"] });
    expect(await startEmailSignIn("x", respond(400, { error: "enter a valid email address", errorKey: "serverError.email.invalid" })))
      .toEqual({ ok: false, error: ptBr["serverError.email.invalid"] });
    setLocale("en");
    expect(await pairWithCode({ code: "AAAA-BBBB-CCCC", label: "Phone" }, respond(401, { error: WRONG, errorKey: "serverError.pair.codeWrong" })))
      .toEqual({ ok: false, error: WRONG });
    expect(await pairWithCode({ code: "AAAA-BBBB-CCCC", label: "Phone" }, respond(401, { error: WRONG })))
      .toEqual({ ok: false, error: WRONG });
  });
});

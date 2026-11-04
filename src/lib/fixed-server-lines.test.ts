import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { setLocale } from "./i18n";
import { activityText, noticeText, routineLineText } from "./activity-text";
import { serverErrorText } from "./server-error";
import { modelOptionLabel } from "./model-label";
import { localizedCard } from "./widget-text";
import { CHAT_NOTICE, chatNotice, noticeFailure, noticeLine } from "../../server/chat-notices";
import { recoveredText } from "../../server/automation-reports";
import "../../server/server-line-packs";
import { USER_ERROR, userError, userErrorFields } from "../../server/user-errors";
import { parseConfigPatch } from "../../server/config";
import { parseConfigPatchForPerson } from "../../server/decider/config-errors";
import { engineFailure, plainFailure } from "../../server/drivers/engine-errors";
import { inboxWhy, inboxNoteWords } from "../../server/host/inbox-words";
import { briefCard } from "../../server/host/brief-cards";
import { phoneWriteSummary } from "../../server/phones/summary";
import { phoneAccess } from "../../server/phones/access";
import { exportedGoalWords, restoredGoalWords } from "../../server/team-backup-words";
import { createGoalCards } from "../../server/host/goal-cards";
import { GoalRunCard } from "../components/GoalRunCard";
import type { GoalCardDeps } from "../../server/host/goal-cards";
import type { Message } from "@/state/store";
import type { WidgetPayload } from "../../shared/widget";

afterEach(() => setLocale("en"));
const secret = `sk-ant-${"Ab1c".repeat(9)}`;

describe("fixed server words", () => {
  it("keeps canonical English and string params for ACP cancellation failures", () => {
    for (const [key, english] of [
      ["chat.notice.acpRestarted", "Grok was restarted because a session sharing its process ignored Stop"],
      ["chat.notice.acpStopFailed", "Grok ignored Stop and its process could not be ended"],
    ] as const) {
      const failed = noticeFailure(key, { provider: "Grok" });
      expect(failed).toEqual({ message: english, text: { key, params: { provider: "Grok" } } });
      expect(noticeText(key, failed.message, failed.text.params)).toBe(english);
      setLocale("pt-br");
      expect(noticeText(key, failed.message, failed.text.params)).toContain("ignorou “Parar”");
      setLocale("en");
    }
  });

  it.each(["128", undefined])("codes a tool-count refusal with limit %s, without an English part param", (limit) => {
    const raw = "provider error";
    const failed = engineFailure("Grok", limit ? `maximum ${limit} tools` : raw, { kind: "tool_count" })!;
    expect(failed.text?.key).toBe(limit ? "chat.notice.toolCount" : "chat.notice.toolCountUnknown");
    expect(Object.values(failed.text?.params ?? {}).every((value) => typeof value === "string")).toBe(true);
    expect(failed.message).toContain("so nothing ran.");
    setLocale("pt-br");
    expect(noticeText(failed.text?.key, failed.message, failed.text?.params)).toContain("Nada foi executado.");
  });

  it("preserves tool-count codes on the chat-completions error boundary", () => {
    const raw = "maximum 128 tools";
    expect(plainFailure("Grok", raw)).toEqual(engineFailure("Grok", raw));
    expect(plainFailure("Grok", "technical error")).toEqual({ message: "technical error" });
  });

  it("resolves only declared reference params, and scrubs both params and fallbacks", () => {
    const line = noticeLine("chat.notice.goalRetry", { name: "Scout", why: "chat.notice.part.dispatchFailed" });
    expect(line.text).toBe("Scout's turn did not settle (dispatch failed) — retrying once.");
    setLocale("pt-br");
    expect(noticeText(line.textCode, line.text, line.textParams)).toBe("A sessão de Scout não terminou como esperado (não foi possível iniciar) — tentando mais uma vez.");
    const providerFailure = noticeLine("chat.notice.goalRetry", { name: "Scout", why: "chat.notice.part.providerFailed" });
    expect(noticeText(providerFailure.textCode, providerFailure.text, providerFailure.textParams))
      .toBe("A sessão de Scout não terminou como esperado (o provedor falhou) — tentando mais uma vez.");
    expect(chatNotice("chat.notice.goalWaiting", { name: "chat.notice.part.dispatchFailed" })).toContain("chat.notice.part.dispatchFailed");
    for (const line of [noticeLine("chat.notice.goalWorking", { name: secret, turn: "1", max: "13" }), noticeFailure("chat.notice.acpRestarted", { provider: secret })]) {
      expect(JSON.stringify(line)).not.toContain(secret);
    }
  });

  it("uses separate complete lines for singular and plural waits", () => {
    setLocale("pt-br");
    for (const [key, minutes, expected] of [["chat.notice.goalBusyOneAgain", "1", "minuto"], ["chat.notice.goalBusyManyAgain", "30", "minutos"]] as const) {
      const line = noticeLine(key, { name: "Scout", minutes });
      expect(routineLineText(line.textCode, line.text, line.textParams)).toBe(`Scout continuou trabalhando por ${minutes} ${expected} — envie o objetivo novamente quando o bot estiver livre.`);
    }
  });

  it("words recovery on the server in the host's clock and the person's language", () => {
    const at = Date.UTC(2026, 9, 26, 15, 30);
    expect(recoveredText("Check", at)).toMatch(/^Recovered: Check finished OK at /);
    const time = new Intl.DateTimeFormat("pt-BR", { hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(at).replace(/\s/g, " ");
    expect(recoveredText("Check", at, "pt-br")).toBe(`Voltou a funcionar: Check terminou com sucesso às ${time}`);
  });

  it("does not leave an English generic teammate inside a translated line", () => {
    setLocale("pt-br");
    expect(activityText({ nameCode: "chat.notice.unknownTeammateWorking" }, CHAT_NOTICE["chat.notice.unknownTeammateWorking"]))
      .toBe("Parou aqui — um colega continua trabalhando; abra para parar esse trabalho também");
  });

  it("words approval prefixes without translating the title", () => {
    const line = noticeLine("chat.notice.approve", { what: "Send the draft" });
    expect(line.text).toBe("Approve: Send the draft");
    setLocale("pt-br");
    expect(noticeText(line.textCode, line.text, line.textParams)).toBe("Aprovar: Send the draft");
  });

  it("words a generic Chief conflict without gendered fallback params", () => {
    setLocale("pt-br");
    const body = userError("serverError.owner.unassignedChiefConflict");
    expect(serverErrorText(body, body.error)).toBe("Essa pessoa já tem um chefe de gabinete. Remova a coroa de um deles primeiro.");
    const named = userError("serverError.owner.choose", { team: secret });
    expect(JSON.stringify(named)).not.toContain(secret);
    expect(serverErrorText(named, named.error)).not.toContain(secret);
  });

  it("words a recursive backup link refusal while keeping its path as redacted string data", () => {
    const body = userError("serverError.backup.recursiveLink", { path: "workspaces/ws/project/loop" });
    expect(body.error).toBe("Cannot back up a symbolic link to the folder that contains it: workspaces/ws/project/loop");
    expect(serverErrorText(body, body.error)).toBe(body.error);
    setLocale("pt-br");
    expect(serverErrorText(body, body.error)).toBe("Não é possível incluir no backup um link simbólico para a pasta que o contém: workspaces/ws/project/loop");
    expect(JSON.stringify(userError("serverError.backup.recursiveLink", { path: secret }))).not.toContain(secret);
  });

  it("adds a code to the exact account schema refusal without changing its English or status", () => {
    const body = { decider: { workersAiAccountId: "bad" } };
    let original: Error | undefined;
    try { parseConfigPatch(body); } catch (error) { original = error as Error; }
    try { parseConfigPatchForPerson(body); throw new Error("accepted invalid account"); }
    catch (error) {
      const headText = "decider.workersAiAccountId a Cloudflare account ID is 32 letters and digits";
      expect(original!.message).toBe(headText);
      expect((error as Error).message).toBe(headText);
      setLocale("en");
      expect(serverErrorText(userErrorFields(error), (error as Error).message)).toBe(headText);
      expect((error as { status: number }).status).toBe(400);
      expect(userErrorFields(error)).toEqual({ errorKey: "serverError.decider.accountFormat" });
      setLocale("pt-br");
      expect(serverErrorText(userErrorFields(error), original!.message)).toBe("decider.workersAiAccountId: o ID de uma conta da Cloudflare tem 32 letras e números");
    }
    expect(() => parseConfigPatchForPerson({ decider: { workersAiBaseUrl: "bad" } })).toThrow();
    expect(USER_ERROR["serverError.decider.accountFormat"]).toBe("decider.workersAiAccountId a Cloudflare account ID is 32 letters and digits");
  });

  it.each([
    ["serverError.decider.accountRequired", "Add your Cloudflare account ID with the token."],
    ["serverError.decider.keyRequired", "Save a Cloudflare Workers AI, Jev or OpenRouter key before turning on fast decisions."],
    ["serverError.decider.jevRejected", "Jev rejected this key. Check it at typesafe.ai and paste it again."],
    ["serverError.decider.workersRejected", "Cloudflare rejected this token. Check that it has Workers AI permission and belongs to this account ID."],
    ["serverError.decider.routerRejected", "OpenRouter rejected this key. Check it at openrouter.ai/keys and paste it again."],
    ["serverError.decider.accountId", "A Cloudflare account ID is 32 letters and digits."],
  ] as const)("keeps the HEAD English of the sibling refusal %s in the renderer", (key, headText) => {
    const body = userError(key);
    setLocale("en");
    expect(body.error).toBe(headText);
    expect(serverErrorText(body, body.error)).toBe(headText);
  });

  it("translates only the app-owned agent-default sentinel", () => {
    expect(modelOptionLabel({ id: "agent-default", label: "Agent default" })).toBe("Agent default");
    setLocale("pt-br");
    expect(modelOptionLabel({ id: "agent-default", label: "Agent default" })).toBe("Padrão do agente");
    expect(modelOptionLabel({ id: "other", label: "Agent default" })).toBe("Agent default");
    expect(modelOptionLabel({ id: "agent-default", label: "Vendor default" })).toBe("Vendor default");
  });
});

describe("inbox reasons on the brief", () => {
  it("preserves English and formats extracted dates and amounts only when rendering pt-BR", () => {
    const picked = inboxWhy({ ask: "to revisar o pedido", deadline: "2026-10-30", amount: 1234.5 });
    expect(picked.why).toBe("Asks you to revisar o pedido, due 2026-10-30, about 1,234.5.");
    expect(picked.whyText?.params).toEqual({ ask: "revisar o pedido", deadline: "2026-10-30", amount: "1,234.5", amountValue: "1234.5" });
    const built = briefCard({ now: Date.UTC(2026, 9, 26), intro: false, needs: [], meetings: null, emails: [{ messageId: "a", threadId: "t", from: "Ana", subject: "Pedido", needsReply: true, ...picked }], routines: [] });
    const payload: WidgetPayload = { v: 1, root: built.card };
    expect(localizedCard(payload, true)).toBe(payload);
    setLocale("pt-br");
    expect(localizedCard(payload, true).root.children?.[1]?.children?.[1]?.value).toBe("Aguardando sua resposta · Pedido: revisar o pedido · prazo: 30 de out. de 2026 · valor aproximado: 1.234,5.");
  });

  it.each(["due", "askDue", "dueAmount", "askDueAmount", "waiting.due", "waiting.askDue", "waiting.dueAmount", "waiting.askDueAmount"])("formats an ISO deadline for %s without rewriting its params or its English", (shape) => {
    const params = { ask: "confirmar", deadline: "2026-10-30", amount: "1,200", amountValue: "1200" };
    const payload: WidgetPayload = { v: 1, root: { id: "deadline", type: "text", value: "English fallback", i18n: { value: { key: `brief.inbox.${shape}`, params } } } };
    expect(localizedCard(payload, true)).toBe(payload);
    setLocale("pt-br");
    expect(localizedCard(payload, true).root.value).toContain("30 de out. de 2026");
    expect(params.deadline).toBe("2026-10-30");
    expect(localizedCard(payload, false)).toBe(payload);
  });

  it.each(["amanhã", "October 30, 2026", "2026-13-30", "2026-02-30", "2026-10-30Tinvalid"])("keeps the free-form or invalid deadline %s as data", (deadline) => {
    const payload: WidgetPayload = { v: 1, root: { id: "deadline", type: "text", value: "English fallback", i18n: { value: { key: "brief.inbox.due", params: { deadline } } } } };
    setLocale("pt-br");
    expect(localizedCard(payload, true).root.value).toContain(deadline);
  });

  it("formats ISO timestamps in the renderer's time zone and date-only values without a day shift", () => {
    setLocale("pt-br");
    for (const deadline of ["2026-10-30", "2026-10-30T12:00:00Z"]) {
      const payload: WidgetPayload = { v: 1, root: { id: "deadline", type: "text", value: deadline, i18n: { value: { key: "brief.inbox.due", params: { deadline } } } } };
      const options: Intl.DateTimeFormatOptions = { dateStyle: "medium", ...(deadline.length === 10 ? { timeZone: "UTC" } : {}) };
      expect(localizedCard(payload, true).root.value).toContain(new Intl.DateTimeFormat("pt-BR", options).format(new Date(deadline)));
      setLocale("en");
      expect(localizedCard(payload, true)).toBe(payload);
      setLocale("pt-br");
    }
  });

  it.each([1, 2, 3, 4, 5, 6, 7])("keeps only string params for reason shape %s", (mask) => {
    const picked = inboxWhy({ ...(mask & 1 ? { ask: "confirmar" } : {}), ...(mask & 2 ? { deadline: "amanhã" } : {}), ...(mask & 4 ? { amount: 1200 } : {}) });
    expect(picked.whyText).toBeDefined();
    expect(Object.values(picked.whyText!.params!).every((value) => typeof value === "string")).toBe(true);
    expect(inboxNoteWords(picked.why, picked.whyText, true)?.key).toMatch(/^brief\.inbox\.waiting\./);
  });

  it("drops stale or truncated metadata and redacts extracted secrets", () => {
    const picked = inboxWhy({ ask: "a".repeat(120), deadline: "b".repeat(180), amount: 1200 });
    expect(picked.why.length).toBeLessThanOrEqual(240);
    expect(picked.whyText).toBeUndefined();
    const safe = inboxWhy({ ask: `check ${secret}` });
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(inboxNoteWords("changed", safe.whyText, false)).toBeUndefined();
    expect(JSON.stringify(inboxWhy({ ask: `${"x".repeat(110)} ${secret}` }))).not.toContain("sk-ant-");
    expect(JSON.stringify(inboxWhy({ deadline: `${"x".repeat(220)} ${secret}` }))).not.toContain("sk-ant-");
  });
});

describe("phone summaries", () => {
  it("keeps tool names as data but words fixed decisions and known writes", () => {
    const allowed = phoneAccess({ id: "b", name: "Bot" }, { calendar: "full" }, "PHONE_CREATE_EVENT").rows[0]!;
    const denied = phoneAccess({ id: "b", name: "Bot" }, {}, "PHONE_CREATE_EVENT").rows[0]!;
    const written = phoneWriteSummary("PHONE_CREATE_EVENT", "iPhone");
    expect(written.summary).toBe("Create event on iPhone");
    setLocale("pt-br");
    expect(routineLineText(allowed.summaryCode, allowed.summary!, allowed.summaryParams)).toBe("permitido: PHONE_CREATE_EVENT");
    expect(routineLineText(denied.summaryCode, denied.summary!, denied.summaryParams)).toBe("Sem permissão para acessar o Calendário no celular");
    expect(routineLineText(written.summaryCode, written.summary, written.summaryParams)).toBe("Criar evento em iPhone");
    expect(routineLineText(written.summaryCode, "Later summary", written.summaryParams)).toBe("Later summary");
  });

  it("fits long phone names and removes secrets before truncating them", () => {
    const written = phoneWriteSummary("PHONE_CREATE_EVENT", `Device ${secret} ${"x".repeat(300)}`);
    expect(written.summary.length).toBeLessThanOrEqual(240);
    expect(JSON.stringify(written)).not.toContain(secret);
    setLocale("pt-br");
    expect(routineLineText(written.summaryCode, written.summary, written.summaryParams)).toMatch(/^Criar evento em Device /);
  });
});

describe("exported goal history", () => {
  it.each(["constructor", "__proto__", "serverError.owner.choose", "chat.notice.approve", "chat.notice.exportedGoal.fake"])("drops the non-goal code %s before re-export", (textCode) => {
    expect(restoredGoalWords({ role: "bot", text: "Approve: free text", textCode, textParams: { before: "", content: "free text" } })).toEqual({});
  });

  it("drops incomplete params and strips extra params before preserving goal words", () => {
    const message = { role: "bot", text: "[Goal: completed]Free text", textCode: "chat.notice.exportedGoal.completed" };
    expect(restoredGoalWords({ ...message, textParams: { before: "", content: 123 } })).toEqual({});
    expect(restoredGoalWords({ ...message, textParams: { before: "" } })).toEqual({});
    expect(restoredGoalWords({ ...message, textParams: { before: "", content: "Free text", extra: "chat.notice.approve" } }).textParams)
      .toEqual({ before: "", content: "Free text" });
  });

  it.each([
    ["working", "em andamento"], ["completed", "concluído"], ["needs-input", "aguardando resposta"], ["blocked", "bloqueado"],
    ["limit-reached", "limite atingido"], ["paused", "em pausa"], ["stopped", "interrompido"], ["failed", "falhou"],
  ] as const)("words the %s marker after import without translating the saved content", (status, portuguese) => {
    const text = `[Goal: ${status}]\nFree text\nModel's words`;
    const goalRun = { runId: "r", goal: "Free text", detail: "Model's words", status, coordinatorBotId: "b", coordinatorName: "Bot", turnCount: 1, maxTurns: 13, startedAt: 1 };
    const words = exportedGoalWords({ role: "bot", goalRun }, text);
    expect(words.text).toBe(text);
    const restored = restoredGoalWords({ id: "m", role: "bot", at: 1, parentId: null, ...words });
    expect(noticeText(restored.textCode, text, restored.textParams)).toBe(text);
    setLocale("pt-br");
    expect(noticeText(restored.textCode, text, restored.textParams)).toBe(`[Objetivo: ${portuguese}]\nFree text\nModel's words`);
    expect(restoredGoalWords({ id: "m", role: "bot", at: 1, parentId: null, ...words, text: "Changed" })).toEqual({});
    expect(restoredGoalWords({ id: "m", role: "user", at: 1, parentId: null, ...words })).toEqual({});
    expect(exportedGoalWords({ role: "bot", goalRun }, "Unrelated")).toEqual({ text: "Unrelated" });
  });
});

describe("goal detail receipts", () => {
  it("persists codes beside English, clears stale codes, and renders the card in pt-BR", () => {
    let message: Message | undefined;
    const store = {
      appendMessage: (_thread: string, row: Message) => { message = { ...row, id: "card", at: 1 }; return message; },
      messagesFor: () => message ? [message] : [],
      patchMessage: (_thread: string, _id: string, patch: Partial<Message>) => { message = { ...message!, ...patch }; },
      bot: () => undefined,
    };
    const cards = createGoalCards({ store, routines: () => null, notify: vi.fn(), routineSourceOwner: () => null, routineSourceThread: () => null } as unknown as GoalCardDeps);
    const run = cards.start("t", { id: "b", name: "Scout", color: "teal" }, "Test", "run");
    const waiting = noticeFailure("chat.notice.goalWaiting", { name: "Scout" });
    cards.progress("t", run, waiting.message, waiting.text);
    expect(message!.goalRun).toMatchObject({ detail: waiting.message, detailCode: waiting.text.key, detailParams: { name: "Scout" } });
    setLocale("pt-br");
    expect(renderToStaticMarkup(createElement(GoalRunCard, { message: message! }))).toContain("Scout está terminando o que está fazendo.");
    cards.progress("t", run, "Model supplied detail");
    expect(message!.goalRun?.detailCode).toBeUndefined();
    const ended = noticeFailure("chat.notice.goalEnded");
    cards.finish("t", run, "failed", ended.message, () => true, ended.text);
    expect(message!.goalRun?.detailCode).toBe("chat.notice.goalEnded");
    expect(renderToStaticMarkup(createElement(GoalRunCard, { message: message! }))).toContain("A execução do objetivo terminou antes de o bot informar um resultado.");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { noticeFailure, runtimeNoticeTool } from "../../server/chat-notices";
import type { Message } from "../state/store";
import { RelayLabel } from "../components/InboxLine";
import { acpStopFailure } from "../../server/drivers/acp/failure-words";
import { stopCause, stopFailure } from "../../server/drivers/engine-errors";
import { unsupportedCallsFailure, unsupportedCallsNotice } from "../../server/drivers/codex-unsupported-calls";
import { unaskedStopFailure, unaskedStopMessage } from "../../server/harness/unasked-stop";
import "../../server/server-line-packs";
import { droppedLine, fullLine, laterLine, notYetLine, refusedLine, sentLine } from "../../server/host/devs-report-words";
import { sentRow } from "../../server/host/handoff-sent";
import { userError } from "../../server/user-errors";
import { EngineCheckLine } from "../components/EngineLiveCheck";
import { activityText, noticeText } from "./activity-text";
import { setLocale } from "./i18n";
import { serverErrorText } from "./server-error";

afterEach(() => setLocale("en"));
const secret = `sk-ant-${"Ab1c".repeat(9)}`;

describe("fixed runtime notices", () => {
  it.each([
    ["refusal", "chat.notice.stop.refusal", "Grok refused to go on with this request (stop reason: refusal). Try again, reword the request, or switch this bot to another AI.", "se recusou a continuar"],
    ["max_tokens", "chat.notice.stop.maxTokens", "Grok's reply reached its maximum length before it finished (stop reason: max_tokens). Ask it to continue, or ask for a shorter answer.", "atingiu o tamanho máximo"],
    ["max_turn_requests", "chat.notice.stop.maxRequests", "The turn made as many model requests as one turn may before it finished (stop reason: max_turn_requests). Ask it to carry on from where it stopped, or split the task.", "limite de pedidos"],
  ])("keeps the complete English and codes ACP stop %s", (reason, key, english, portuguese) => {
    const failed = acpStopFailure({ stopReason: reason }, "Grok");
    expect(failed.message).toBe(english);
    expect(failed.text?.key).toBe(key);
    expect(stopCause(reason, "Grok")).toBe(english);
    const tool = runtimeNoticeTool(failed);
    expect(tool.name).toBe(`notice: ${english.slice(0, 240)}`);
    expect(activityText(tool, tool.name)).toBe(tool.name);
    setLocale("pt-br");
    expect(activityText(tool, tool.name)).toContain(portuguese);
    expect(activityText(tool, tool.name)).toContain(reason);
  });

  it("uses generic complete sentences, while unknown diagnostics and vendor messages stay untouched", () => {
    expect(stopFailure("refusal")?.text?.key).toBe("chat.notice.stop.refusalGeneric");
    expect(stopCause("max_tokens")).toBe("The AI's reply reached its maximum length before it finished (stop reason: max_tokens). Ask it to continue, or ask for a shorter answer.");
    expect(acpStopFailure({}, "Grok")).toEqual(noticeFailure("chat.notice.acpNoReason", { provider: "Grok" }));
    expect(acpStopFailure({ error: "vendor detail", stopReason: "refusal" }, "Grok")).toEqual({ message: "vendor detail" });
    expect(acpStopFailure({ message: "vendor message" }, "Grok")).toEqual({ message: "vendor message" });
    expect(stopCause("rpc_error")).toBe("The engine stopped without saying why (stop reason: rpc_error).");
    expect(stopFailure(" ")).toBeUndefined();
    setLocale("pt-br");
    expect(noticeText("chat.notice.future", "Future English")).toBe("Future English");
    expect(noticeText("native.update.installing", "Wrong namespace")).toBe("Wrong namespace");
    expect(noticeText("chat.notice.cutOffByRestart", "Missing params")).toBe("Missing params");
    expect(runtimeNoticeTool({ message: "Old engine" })).toEqual({ name: "notice: Old engine", ok: true });
  });

  it.each([1, 2, 7])("preserves Codex's exact plural and six-name cap for %s tools", (count) => {
    const tools = Array.from({ length: count }, (_, i) => `app.TOOL_${i}`);
    const named = tools.slice(0, 6).join(", ") + (count > 6 ? ` and ${count - 6} more` : "");
    const english = `Codex could not run ${count === 1 ? "the tool" : "the tools"} ${named} ("unsupported call"): the AI provider sent the call back without the tool's app name, so it never reached the tool. Pick a model for this bot whose provider handles tool calls fully.`;
    const failed = unsupportedCallsFailure(tools);
    expect(failed.message).toBe(english);
    expect(unsupportedCallsNotice(tools)).toBe(english);
    expect(failed.text.key).toBe(count > 6 ? "chat.notice.codexUnsupportedMore" : count === 1 ? "chat.notice.codexUnsupportedOne" : "chat.notice.codexUnsupportedMany");
    setLocale("pt-br");
    const tool = runtimeNoticeTool(failed);
    expect(activityText(tool, tool.name)).toContain(count === 1 ? "a ferramenta app.TOOL_0" : "as ferramentas app.TOOL_0");
    expect(activityText(tool, tool.name)).not.toContain("app.TOOL_6");
    if (count > 6) expect(activityText(tool, tool.name)).toContain("e mais 1");
  });

  it("keeps cancellation quotes and redacts parameters before they reach the transcript", () => {
    expect(unaskedStopMessage('  Request\nwas "aborted".  ')).toBe('The AI\'s request was cut off before it finished, and nobody stopped it (it said only "Request was \'aborted\'."). Send the message again to try once more.');
    const failed = unaskedStopFailure(`Request was aborted. ${secret}`);
    expect(JSON.stringify(failed)).not.toContain(secret);
    setLocale("pt-br");
    expect(noticeText(failed.text.key, failed.message, failed.text.params)).toContain("sem que ninguém o parasse");
    expect(JSON.stringify(runtimeNoticeTool(noticeFailure("chat.notice.acpEmpty", { provider: secret })))).not.toContain(secret);
  });

  it.each([
    ["chat.notice.acpEmpty", { provider: "Grok" }, "Grok finished without replying.", "Grok terminou sem responder."],
    ["chat.notice.piSessionSlow", undefined, "Pi is taking longer than usual to start this conversation's session. The turn goes on when Pi answers. Press Stop to cancel it.", "Clique em “Parar” para cancelar."],
    ["chat.notice.unreadMessage", undefined, "This turn ended before the model read a message sent while it ran. Send that message again.", "Envie essa mensagem novamente."],
  ] as const)("persists and renders %s", (key, params, english, portuguese) => {
    const failed = noticeFailure(key, params);
    expect(failed.message).toBe(english);
    setLocale("pt-br");
    const tool = runtimeNoticeTool(failed);
    expect(activityText(tool, tool.name)).toContain(portuguese);
  });
});

describe("report receipts", () => {
  it.each([false, true])("keeps contact variants and English parity (later=%s)", (later) => {
    for (const contact of [undefined, "reply@example.test"]) {
      const make = later ? laterLine : sentLine;
      expect(make("report-42", contact, "en")).toBe(`Sent to the MausBot team (report report-42)${later ? " after an earlier try did not go through" : ""}. Milind and Omkar get it by email${contact ? ` and will reply to ${contact}` : ""}.`);
      expect(make("report-42", contact, "pt-br")).toContain("Enviado à equipe do MausBot (relatório report-42)");
      if (contact) expect(make("report-42", contact, "pt-br")).toContain(contact);
    }
  });

  it.each([undefined, 1, 120_000])("keeps complete wait lines and singular/plural minutes (%s)", (retryAfterMs) => {
    const outcome = { ok: false as const, retry: true as const, why: "limited" as const, ...(retryAfterMs ? { retryAfterMs } : {}) };
    const minutes = retryAfterMs ? Math.ceil(retryAfterMs / 60_000) : 0;
    expect(notYetLine(outcome, "en")).toBe(`Not sent yet: the MausBot team takes only a few reports an hour from each app. The report is saved and goes on its own${minutes ? ` in about ${minutes} minute${minutes === 1 ? "" : "s"}` : " as soon as it can"}, so there is no need to send it again.`);
    expect(notYetLine(outcome, "pt-br")).toContain(minutes ? `em cerca de ${minutes} minuto${minutes === 1 ? "" : "s"}` : "assim que possível");
  });

  it("localizes offline and refusal lines, with the diagnostic kept as data", () => {
    expect(notYetLine({ ok: false, retry: true, why: "offline" }, "pt-br")).toContain("não foi possível conectar ao servidor da equipe do MausBot");
    expect(notYetLine({ ok: false, retry: true, why: "server" }, "pt-br")).toContain("o servidor da equipe do MausBot não pôde receber o relatório agora");
    expect(refusedLine("too large. \n", "en")).toBe("The MausBot team's server refused this bug report, so nothing was sent: too large.");
    expect(refusedLine("too large. \n", "pt-br")).toBe("O servidor da equipe do MausBot recusou este relatório de problema, então nada foi enviado: too large.");
    expect(fullLine(40, "pt-br")).toBe("Não foi enviado: já há 40 relatórios de problemas na fila para a equipe do MausBot. Aguarde o envio e digite @devs novamente.");
    expect(droppedLine("pt-br")).toBe("Um relatório de problema desta conversa ficou uma semana sem chegar à equipe do MausBot e, por isso, foi descartado. Digite @devs novamente para enviar outro.");
  });
});

describe("handoffs and team relay bodies", () => {
  it.each([
    ["reply", "Ana replied", "Ana respondeu"],
    ["assistant", "Ana&#x27;s assistant answered", "O assistente de Ana respondeu"],
    ["told", "", ""],
  ] as const)("labels a %s without translating the sender's message", (kind, english, portuguese) => {
    const message: Message = { id: "relay-1", role: "user", kind: "text", at: 1, text: "Keep English", relay: { kind, email: "ana@example.test", name: "Ana" } };
    const render = () => renderToStaticMarkup(createElement("div", null, createElement(RelayLabel, { message }), message.text));
    expect(render()).toContain(english);
    expect(render()).toContain("Keep English");
    setLocale("pt-br");
    expect(render()).toContain(portuguese);
    expect(render()).toContain("Keep English");
    if (kind === "told") expect(render()).not.toContain("data-relay");
  });

  it("localizes normal handoffs on the server and retains the direct-outside-room sentinel", () => {
    const sender = { id: "a", name: "Ana", color: "blue" }, recipient = { id: "b", name: "Scout", color: "green" };
    const row = sentRow({ sender, recipient, threadId: "t", via: "room", room: { id: "r", name: "Sales", here: false } });
    expect(row.tool).toMatchObject({ name: "Sent to Scout · Sales" });
    expect(row.tool?.nameCode).toBeUndefined();
    setLocale("pt-br");
    const translated = sentRow({ sender, recipient, threadId: "t", via: "room", room: { id: "r", name: "Sales", here: false }, language: "pt-br" });
    expect(activityText(translated.tool!, translated.tool!.name)).toBe("Enviado para Scout · Sales");
    const direct = sentRow({ sender, recipient, threadId: "t", via: "direct", room: { id: "r", name: "Sales", here: false } });
    expect(direct.tool?.nameCode).toBeUndefined();
    expect(direct.sentDirectly).toEqual({ name: "Scout", room: "Sales" });
  });
});

it("rerenders an engine-check timeout and setup/approval refusals from the stored English", () => {
  const body = userError("serverError.engineCheck.timeout", { name: "Grok", seconds: "90" });
  const render = () => renderToStaticMarkup(createElement(EngineCheckLine, { name: "Grok", check: { state: "failed", ...body }, onRetry() {} }));
  expect(render()).toContain("Grok didn&#x27;t answer within 90 seconds.");
  setLocale("pt-br");
  expect(render()).toContain("Grok não respondeu em 90 segundos.");
  for (const key of ["serverError.setup.noTools", "serverError.setup.missingConversation", "serverError.setup.stopOwner", "serverError.setup.hasInstructions", "serverError.setup.started", "serverError.setup.someoneElse", "serverError.approval.allThreads", "serverError.approval.pending", "serverError.approval.provider"] as const) {
    const refusal = userError(key);
    expect(serverErrorText(refusal, refusal.error)).not.toBe(refusal.error);
    setLocale("en");
    expect(serverErrorText(refusal, refusal.error)).toBe(refusal.error);
    setLocale("pt-br");
  }
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { noticeFailure, noticeLine, runtimeNoticeTool } from "../../server/chat-notices";
import { acpStopFailure } from "../../server/drivers/acp/failure-words";
import { stopCause, stopFailure } from "../../server/drivers/engine-errors";
import { unsupportedCallsFailure, unsupportedCallsNotice } from "../../server/drivers/codex-unsupported-calls";
import { unaskedStopFailure, unaskedStopMessage } from "../../server/harness/unasked-stop";
import { droppedReportLine, fullReportLine, notYetReportLine, refusedReportLine, sentReportLine } from "../../server/host/devs-report-words";
import { sentRow } from "../../server/host/handoff-sent";
import { userError } from "../../server/user-errors";
import { EngineCheckLine } from "../components/EngineLiveCheck";
import { activityText, noticeText } from "./activity-text";
import { setLocale } from "./i18n";
import { serverErrorText } from "./server-error";

afterEach(() => setLocale("en"));
const secret = `sk-ant-${"Ab1c".repeat(9)}`;
const words = (line: { line: string; text?: ReturnType<typeof sentReportLine>["text"] }) => noticeText(line.text?.key, line.line, line.text?.params);

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
    expect(noticeText("chat.notice.relayReply", "Missing params")).toBe("Missing params");
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
    ["chat.notice.unreadMessage", undefined, "This turn ended before the model read a message sent while it ran. Send that message again.", "Envie essa mensagem de novo."],
  ] as const)("persists and renders %s", (key, params, english, portuguese) => {
    const failed = noticeFailure(key, params);
    expect(failed.message).toBe(english);
    setLocale("pt-br");
    const tool = runtimeNoticeTool(failed);
    expect(activityText(tool, tool.name)).toContain(portuguese);
  });
});

describe("report receipts", () => {
  it.each([false, true])("preserves the contact and earlier-try variants (later=%s)", (later) => {
    for (const contact of [undefined, "reply@example.test"]) {
      const line = sentReportLine("report-42", contact, later);
      expect(line.line).toBe(`Sent to the MausBot team (report report-42)${later ? " after an earlier try did not go through" : ""}. Milind and Omkar get it by email${contact ? ` and will reply to ${contact}` : ""}.`);
      expect(words(line)).toBe(line.line);
      setLocale("pt-br");
      expect(words(line)).toContain("Enviado à equipe do MausBot (relatório report-42)");
      if (contact) expect(words(line)).toContain(contact);
      setLocale("en");
    }
  });

  it.each([undefined, 1, 120_000])("preserves complete wait lines and string minute params (%s)", (retryAfterMs) => {
    const line = notYetReportLine({ ok: false, retry: true, why: "limited", ...(retryAfterMs ? { retryAfterMs } : {}) });
    const minutes = retryAfterMs ? Math.ceil(retryAfterMs / 60_000) : 0;
    expect(line.line).toBe(`Not sent yet: the MausBot team takes only a few reports an hour from each app. The report is saved and goes on its own${minutes ? ` in about ${minutes} minute${minutes === 1 ? "" : "s"}` : " as soon as it can"}, so there is no need to send it again.`);
    expect(Object.values(line.text!.params!).every(value => typeof value === "string")).toBe(true);
    setLocale("pt-br");
    expect(words(line)).toContain(minutes ? `em cerca de ${minutes} minuto${minutes === 1 ? "" : "s"}` : "assim que possível");
  });

  it("keeps vocabulary-blocked server diagnostics English, without a misleading code", () => {
    setLocale("pt-br");
    for (const why of ["offline", "server"] as const) {
      const line = notYetReportLine({ ok: false, retry: true, why });
      expect(line.text).toBeUndefined();
      expect(words(line)).toBe(line.line);
      expect(line.line).toContain("the MausBot team's server");
    }
    expect(refusedReportLine("too large. \n")).toEqual({ line: "The MausBot team's server refused this bug report, so nothing was sent: too large.", text: undefined });
    expect(words(fullReportLine(40))).toContain("40 relatórios de problemas");
    expect(words(droppedReportLine())).toContain("durante uma semana");
    expect(JSON.stringify(sentReportLine("r", secret))).not.toContain(secret);
  });
});

describe("handoffs and team relay bodies", () => {
  it.each([
    ["chat.notice.relayReply", "Ana replied: Keep English", "Ana respondeu: Keep English"],
    ["chat.notice.relayFrom", "Ana asked me to pass this on: Keep English", "Ana pediu para eu repassar esta mensagem: Keep English"],
    ["chat.notice.relayMessage", "A message for you from Ana: Keep English", "Uma mensagem de Ana para você: Keep English"],
  ] as const)("keeps the message and name verbatim in %s", (key, english, portuguese) => {
    const line = noticeLine(key, { name: "Ana", message: "Keep English" });
    expect(line.text).toBe(english);
    setLocale("pt-br");
    expect(noticeText(line.textCode, line.text, line.textParams)).toBe(portuguese);
  });

  it("codes normal handoffs and retains the direct-outside-room sentinel", () => {
    const sender = { id: "a", name: "Ana", color: "blue" }, recipient = { id: "b", name: "Scout", color: "green" };
    const row = sentRow({ sender, recipient, threadId: "t", via: "room", room: { id: "r", name: "Sales", here: false } });
    expect(row.tool).toMatchObject({ name: "Sent to Scout · Sales", nameCode: "chat.notice.handoffSentRoom", nameParams: { name: "Scout", room: "Sales" } });
    setLocale("pt-br");
    expect(activityText(row.tool!, row.tool!.name)).toBe("Enviado a Scout · Sales");
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

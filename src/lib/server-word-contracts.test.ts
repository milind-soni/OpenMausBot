import { afterEach, describe, expect, it } from "vitest";
import { en, type LocaleKey } from "@/locales";
import { activityText, noticeText, routineLineText } from "./activity-text";
import { setLocale, t } from "./i18n";
import { serverErrorText } from "./server-error";
import { USER_ERROR, userError, type UserErrorKey } from "../../server/user-errors";
import { CHAT_NOTICE, noticeFailure, noticeLine, noticeSummary, noticeTool, type ChatNoticeKey } from "../../server/chat-notices";
import { ROUTINE_LINE, codedLine, type RoutineLineKey } from "../../server/routine-lines";

const paramsFor = (template: string) => Object.fromEntries([...template.matchAll(/\{(\w+)\}/g)].map(([, name]) => [name!, `Fixture ${name}`]));
afterEach(() => setLocale("en"));

describe("fixed server words across transport and renderer", () => {
  it.each(Object.entries(USER_ERROR))("renders %s in pt-BR and keeps its English fallback", (key, template) => {
    const params = paramsFor(template);
    const body = userError(key as UserErrorKey, params);
    expect(body.error).toBe(template.replace(/\{(\w+)\}/g, (_, name: string) => params[name]!));
    expect(serverErrorText(body, body.error)).toBe(body.error);
    setLocale("pt-br");
    expect(serverErrorText(body, body.error)).toBe(t(key as LocaleKey, params));
    expect(en[key as LocaleKey]).toBe(template);
    expect(serverErrorText({ errorKey: "serverError.unknown" }, body.error)).toBe(body.error);
  });

  it.each(Object.entries(CHAT_NOTICE).filter(([key]) => !key.includes(".part.")))("renders line, tool, failure and summary %s using the same coded contract", (key, template) => {
    const params = paramsFor(template);
    const line = noticeLine(key as ChatNoticeKey, params);
    const tool = noticeTool(key as ChatNoticeKey, params, { ok: true });
    const failure = noticeFailure(key as ChatNoticeKey, params);
    const summary = noticeSummary(key as ChatNoticeKey, params);
    expect(noticeText(line.textCode, line.text, line.textParams)).toBe(line.text);
    expect(activityText(tool, tool.name)).toBe(tool.name);
    expect(noticeText(failure.text.key, failure.message, failure.text.params)).toBe(failure.message);
    expect(noticeText(summary.summaryCode, summary.summary, summary.summaryParams)).toBe(summary.summary);
    expect(failure.message).toBe(line.text);
    expect(summary.summary).toBe(line.text);
    setLocale("pt-br");
    expect(noticeText(line.textCode, line.text, line.textParams)).toBe(t(key as LocaleKey, params));
    expect(activityText(tool, tool.name)).toBe(t(key as LocaleKey, params));
    expect(noticeText(failure.text.key, failure.message, failure.text.params)).toBe(t(key as LocaleKey, params));
    expect(noticeText(summary.summaryCode, summary.summary, summary.summaryParams)).toBe(t(key as LocaleKey, params));
    expect(en[key as LocaleKey]).toBe(template);
  });

  it.each(Object.entries(ROUTINE_LINE).filter(([key]) => !key.includes(".part.")))("renders the routine line %s without changing stored params", (key, template) => {
    const params = paramsFor(template);
    const line = codedLine("attention", key as RoutineLineKey, params);
    expect(routineLineText(line.codes.attentionCode, line.text, line.codes.attentionParams)).toBe(line.text);
    setLocale("pt-br");
    expect(routineLineText(line.codes.attentionCode, line.text, line.codes.attentionParams)).toBe(t(key as LocaleKey, params));
    expect(en[key as LocaleKey]).toBe(template);
  });
});

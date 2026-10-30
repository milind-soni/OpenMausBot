// The answer a bot's card waits for is that bot's own button; Deny, Cancel and the quiet actions stay neutral, and a
// card no single bot owns keeps the plain primary.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { dispatch: vi.fn() };
});
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ state: {}, dispatch: fixture.dispatch }),
}));

const { BOT_BUTTON, botButtonTone } = await import("@/lib/bot-button");
const { t } = await import("@/lib/i18n");
const { pendingApprovals, PendingApprovalActions } = await import("./PendingApproval");
const { QuestionCard } = await import("./QuestionCard");
const { SecretRequestCard } = await import("./SecretRequestCard");
const { SignInRequestCard } = await import("./SignInRequestCard");
const { ConnectorCard } = await import("./ConnectorCard");

afterAll(() => vi.unstubAllGlobals());

function button(html: string, label: string): string {
  const found = (html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []).find((one) => one.replace(/<[^>]+>/g, "").trim() === label);
  expect(found, label).toBeDefined();
  return found!;
}
const classes = (tag: string) => (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(" ");

function expectOwn(tag: string, color: Bot["color"]) {
  const tone = botButtonTone(color);
  expect(classes(tag)).toContain(BOT_BUTTON);
  expect(classes(tag)).not.toContain("ui-button-primary");
  expect(tag).toContain(`--bot-button:${tone.fill};--bot-button-ink:${tone.ink};--bot-button-hover:${tone.hover};--bot-button-pressed:${tone.pressed}`);
}
function expectPlain(tag: string) {
  expect(classes(tag)).not.toContain(BOT_BUTTON);
  expect(tag).not.toContain("--bot-button");
}

const approval = (bot?: Bot) => {
  const message: Message = {
    id: "approval-1", at: 1, role: "bot", kind: "options",
    card: { title: "Approval needed", subtitle: "rm -rf ./build", options: ["Allow", "Deny"], tool: "Bash", requestId: "request-1", allowSession: true },
  };
  return renderToStaticMarkup(PendingApprovalActions({ pending: pendingApprovals([message])[0]!, bot, threadId: "thread-1", onCancelTurn: vi.fn() }));
};

const question: Message = {
  id: "question-1", role: "bot", kind: "options", at: 1,
  card: {
    title: "Your bot has a question", subtitle: "", options: [], requestId: "request-2",
    questionRequest: { version: 1, questions: [
      { question: "Which page?", header: "Page", options: [{ label: "Home" }, { label: "Pricing" }] },
      { question: "Which tone?", header: "Tone", options: [{ label: "Calm" }, { label: "Bold" }] },
    ] },
  },
};

describe("a bot's cards answer in its own colour", () => {
  it("paints Allow once in the asking bot's colour, while Deny is the neutral second answer and Always allow stays quiet", () => {
    const html = approval({ id: "scout", name: "Scout", color: "pink" } as Bot);
    expectOwn(button(html, t("approval.action.allowOnce")), "pink");
    const deny = button(html, t("approval.action.deny"));
    expectPlain(deny);
    expect(classes(deny)).toEqual(expect.arrayContaining(["bg-ink/[0.07]", "text-ink"]));
    expect(classes(deny).some((name) => name.includes("danger"))).toBe(false);
    const always = button(html, t("approval.action.alwaysAllow"));
    expectPlain(always);
    expect(classes(always)).toContain("text-ink-secondary");
    expect(classes(button(approval(), t("approval.action.allowOnce")))).toContain("bg-accent");
    expectPlain(button(approval(), t("approval.action.allowOnce")));
  });

  it("sends a question's answers in the asking bot's colour, a light one included", () => {
    const own = renderToStaticMarkup(createElement(QuestionCard, { threadId: "thread-1", asker: { name: "Scout", color: "yellow" }, message: question }));
    const submit = button(own, t("question.submitAll"));
    expectOwn(submit, "yellow");
    expect(submit).toContain("disabled");
    expectPlain(button(renderToStaticMarkup(createElement(QuestionCard, { threadId: "thread-1", message: question })), t("question.submitAll")));
  });

  it("saves a key, finishes a sign-in and connects an app in the asking bot's colour", () => {
    const secret: Message = {
      id: "secret-1", role: "bot", kind: "secret", at: 1, text: "",
      secret: { target: "openaiImageApiKey", label: "OpenAI API key", description: "", placeholder: "sk-…", requestKey: "key-1" } as Message["secret"],
    };
    expectOwn(button(renderToStaticMarkup(createElement(SecretRequestCard, { botId: "scout", color: "blue", threadId: "t", message: secret })), "Save securely"), "blue");

    const signIn: Message = {
      id: "signin-1", role: "bot", kind: "signin", at: 1, text: "",
      signIn: { url: "https://example.com/login", site: "example.com", place: "browser" } as Message["signIn"],
    };
    const signInHtml = renderToStaticMarkup(createElement(SignInRequestCard, { botId: "scout", botName: "Scout", color: "green", threadId: "t", message: signIn }));
    expectOwn(button(signInHtml, t("signIn.done")), "green");
    expectPlain(button(signInHtml, t("signIn.cancel")));

    const connector: Message = {
      id: "connector-1", role: "bot", kind: "connector", at: 1,
      connector: { slug: "github", label: "GitHub", description: "", status: "required", resumeKey: "resume-1" },
    };
    expectOwn(button(renderToStaticMarkup(createElement(ConnectorCard, { botId: "scout", color: "silver", threadId: "t", message: connector })), t("connectors.card.connectSecurely")), "silver");
    const plain = button(renderToStaticMarkup(createElement(ConnectorCard, { botId: "scout", threadId: "t", message: connector })), t("connectors.card.connectSecurely"));
    expectPlain(plain);
    expect(classes(plain)).toContain("ui-button-primary");
  });
});

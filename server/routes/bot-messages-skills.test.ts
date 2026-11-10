import { expect, it, vi } from "vitest";
import { createBotMessageRoutes, type BotMessageRouteDeps } from "./bot-messages.ts";

it.each(["/api/bots/fixture/respond", "/api/threads/thread-one/respond"])("awaits the skill resolution before answering %s", async (path) => {
  const result = { claimed: true, outcome: "allowed-once" } as const;
  let finish!: (value: typeof result) => void;
  const pending = new Promise<typeof result>((resolve) => { finish = resolve; });
  const bot = { id: "fixture", threadId: "thread-one", name: "Fixture" };
  const resolveSkillRequest = vi.fn(() => pending), sendSkillResolution = vi.fn(() => true);
  const route = createBotMessageRoutes({
    store: {
      messagesFor: () => [{ from: { botId: bot.id }, card: { requestId: "request-one", skillRequest: {} } }],
      bot: () => bot,
    },
    desktopManaged: true, routines: () => null, requestedTaskBot: () => bot, botForThread: () => bot,
    answeredIn: (threadId: string) => threadId, requestBehavior: () => "allow", cardAnswerRefusal: () => null,
    answeringCardAs: (_auth: unknown, _thread: string, _request: string, work: () => Promise<unknown>) => work(),
    resolveAndSendTrust: () => false, resolveAndSendTeamSetup: async () => false, resolveAndSendMcp: async () => false,
    resolveAndSendRoutine: () => false, resolveAndSendProfile: () => false, resolveAndSendModel: () => false,
    resolveSkillRequest, sendSkillResolution,
  } as unknown as BotMessageRouteDeps);
  const response = route({
    path, method: "POST", req: { headers: {} }, res: {}, auth: { kind: "loopback" },
    readBody: async () => ({ behavior: "allow", requestId: "request-one", reviewedSha256: "fixture-digest" }),
  } as never);
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  expect(resolveSkillRequest).toHaveBeenCalledOnce();
  expect(sendSkillResolution).not.toHaveBeenCalled();
  finish(result);
  await response;
  expect(sendSkillResolution).toHaveBeenCalledWith({}, result);
});

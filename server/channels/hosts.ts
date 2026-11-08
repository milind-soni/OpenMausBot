// Every chat app a bot can be reached on, as one host: the server wires this once, and each app inside keeps its own
// routes, readers and sealed store.
import { PASS, type RouteHandler } from "../routes/table.ts";
import { createSendblueHost, type SendblueHostDeps } from "./sendblue-host.ts";
import { sendblueApiBase } from "./sendblue.ts";
import { createTelegramHost, type TelegramHostDeps } from "./telegram-host.ts";
import { telegramApiBase } from "./telegram.ts";

export type ChannelHostsDeps = Omit<TelegramHostDeps & SendblueHostDeps, "apiBase" | "delays" | "interval">;

export function createChannelHosts(deps: ChannelHostsDeps) {
  const hosts = [createTelegramHost({ ...deps, apiBase: telegramApiBase() }), createSendblueHost({ ...deps, apiBase: sendblueApiBase() })];
  const routes: RouteHandler = async (context) => {
    for (const host of hosts) {
      const answer = await host.routes(context);
      if (answer !== PASS) return answer;
    }
    return PASS;
  };
  return {
    routes,
    noteTurnCompleted: (threadId: string) => Promise.all(hosts.map((host) => host.noteTurnCompleted(threadId))).then(() => undefined),
    prompt: (threadId: string) => hosts.map((host) => host.prompt(threadId)).filter(Boolean).join(" "),
    start: () => hosts.forEach((host) => host.start()),
    stop: () => hosts.forEach((host) => host.stop()),
    pause: () => hosts.forEach((host) => host.pause()),
    resume: () => hosts.forEach((host) => host.resume()),
    busy: () => hosts.some((host) => host.busy()),
  };
}

export type ChannelHosts = ReturnType<typeof createChannelHosts>;

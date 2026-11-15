import { productName } from "./brand.ts";
import type { LiveCallDeps } from "./live-call-controller.ts";
import { openLiveSocket, relayedProvider } from "./live-call-controller.ts";
import { createLiveSession, liveAttachUrl, type LiveBot, type LiveEndpoint, type LiveHistoryMessage } from "./live-call.ts";
import { elevenLabsLiveCallRefusal, fishLiveCallRefusal, geminiLiveCallRefusal } from "./live-access.ts";
import type { LiveConfig } from "./live-config.ts";
import { createFishLiveSession, endFishLiveSession, fishKeyPrint, FishRelays, setUpFishAgent } from "./live-fish.ts";
import { createElevenLabsLiveSession, setUpElevenLabsAgent } from "./live-elevenlabs.ts";
import { createGeminiLiveSession } from "./live-gemini.ts";
import type { LiveRouteDeps } from "./routes/live.ts";

export interface LiveSessionWiringInput {
  bot(botId: string): LiveBot;
  history(threadId: string): LiveHistoryMessage[];
  cloudHome: boolean;
  othersOnLoopback(): boolean;
  /** Saves the Fish Audio or ElevenLabs agent the harness set up, with the account it belongs to. */
  saveAgent(agent: Required<Pick<LiveConfig, "fishAgentId" | "fishAgentFor">> | Required<Pick<LiveConfig, "elevenlabsAgentId" | "elevenlabsAgentFor">>): void;
  /** The name a person reads, which names the agent on their account; the brand's own by default. */
  productName?(): string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/** How a Live call's session starts and is followed, per provider: GPT-Live's WebRTC session and sideband on OpenAI or
 * Azure, or a Fish Audio agent, Gemini Live session or ElevenLabs agent conversation followed through its client's relay. */
export function liveSessionWiring(input: LiveSessionWiringInput): {
  calls: Pick<LiveCallDeps, "fishRefusal" | "geminiRefusal" | "elevenlabsRefusal" | "createSession" | "openSocket" | "attachUrl">;
  fishRelay: LiveRouteDeps["fishRelay"];
} {
  const relays = new FishRelays();
  const relayed = (endpoint: LiveEndpoint) => relayedProvider(endpoint.provider) !== null;
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;

  const setUpAgent = async (key: string, endpoint: LiveEndpoint): Promise<LiveEndpoint> => {
    const fishAgentId = await setUpFishAgent(key, endpoint, (input.productName ?? productName)(), fetchImpl);
    input.saveAgent({ fishAgentId, fishAgentFor: fishKeyPrint(key) });
    return { ...endpoint, model: fishAgentId };
  };

  const startFish = async (key: string, endpoint: LiveEndpoint, botId: string, threadId: string) => {
    const session = { key, bot: input.bot(botId), history: input.history(threadId), cloudHome: input.cloudHome, fetchImpl };
    let agent = endpoint.model ? endpoint : await setUpAgent(key, endpoint);
    try {
      return { agent, token: await createFishLiveSession({ ...session, endpoint: agent }) };
    } catch (error) {
      // An agent removed on Fish Audio is set up again, unless the operator chose it.
      const gone = (error as { fishStatus?: number }).fishStatus === 404 && endpoint.model !== "" && !env.OMB_FISH_LIVE_AGENT_ID?.trim();
      if (!gone) throw error;
      agent = await setUpAgent(key, endpoint);
      return { agent, token: await createFishLiveSession({ ...session, endpoint: agent }) };
    }
  };

  const setUpElevenLabs = async (key: string, endpoint: LiveEndpoint): Promise<LiveEndpoint> => {
    const elevenlabsAgentId = await setUpElevenLabsAgent(key, endpoint, (input.productName ?? productName)(), fetchImpl);
    input.saveAgent({ elevenlabsAgentId, elevenlabsAgentFor: fishKeyPrint(key) });
    return { ...endpoint, model: elevenlabsAgentId };
  };

  const startElevenLabs = async (key: string, endpoint: LiveEndpoint, botId: string, threadId: string) => {
    const session = { key, bot: input.bot(botId), history: input.history(threadId), cloudHome: input.cloudHome, fetchImpl };
    try {
      return await createElevenLabsLiveSession({ ...session, endpoint: endpoint.model ? endpoint : await setUpElevenLabs(key, endpoint) });
    } catch (error) {
      // An agent removed on ElevenLabs is set up again.
      if ((error as { elevenlabsStatus?: number }).elevenlabsStatus !== 404 || !endpoint.model) throw error;
      return createElevenLabsLiveSession({ ...session, endpoint: await setUpElevenLabs(key, endpoint) });
    }
  };

  return {
    fishRelay: (sessionId, token) => relays.find(sessionId, token),
    calls: {
      fishRefusal: (auth) => fishLiveCallRefusal(auth, { othersOnLoopback: input.othersOnLoopback() }),
      geminiRefusal: (auth) => geminiLiveCallRefusal(auth, { othersOnLoopback: input.othersOnLoopback() }),
      elevenlabsRefusal: (auth) => elevenLabsLiveCallRefusal(auth, { othersOnLoopback: input.othersOnLoopback() }),
      createSession: async ({ key, endpoint, sdp, botId, threadId, voice }) => {
        if (endpoint.provider === "gemini") {
          const session = await createGeminiLiveSession({ key, endpoint, voice, bot: input.bot(botId), history: input.history(threadId), cloudHome: input.cloudHome, fetchImpl });
          // Gemini has nothing to end: the session ends when the client closes it, and the token is single use.
          const { token } = relays.open(session.session_id, async () => undefined);
          return { sessionId: session.session_id, gemini: { type: "gemini", session, relayToken: token } };
        }
        if (endpoint.provider === "elevenlabs") {
          const session = await startElevenLabs(key, endpoint, botId, threadId);
          // ElevenLabs has nothing to end either: the conversation ends when the client closes it.
          const { token } = relays.open(session.session_id, async () => undefined);
          return { sessionId: session.session_id, elevenlabs: { type: "elevenlabs", session, relayToken: token } };
        }
        if (endpoint.provider !== "fish") {
          return createLiveSession({ key, endpoint, sdp, voice, bot: input.bot(botId), history: input.history(threadId), cloudHome: input.cloudHome });
        }
        const { agent, token: session } = await startFish(key, endpoint, botId, threadId);
        const { token } = relays.open(session.session_id, () => endFishLiveSession(session.session_id, key, agent, fetchImpl));
        return { sessionId: session.session_id, fish: { type: "fish", session, relayToken: token } };
      },
      openSocket: (url, key, endpoint) => relayed(endpoint) ? relays.socket(url) : openLiveSocket(url, key, endpoint),
      attachUrl: (sessionId, endpoint) => relayed(endpoint) ? sessionId : liveAttachUrl(sessionId, endpoint),
    },
  };
}

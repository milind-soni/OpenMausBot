// The phone integration's per-turn pieces: the mount, the prompt part and the internal MCP handler (owner check, per-bot
// verdict, decision rows, the phone job, write activity). A send waits on the person's Send tap on the phone, never on a
// card of OpenMausBot's own.
import { isOutboundTool } from "../../shared/outbound.ts";
import { PHONE_MCP_SERVER, phoneToolCapability, type PhoneCapability, type PhoneToolName } from "../../shared/phone-apps.ts";
import { appendDecision } from "../decision-log.ts";
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "../proxy-paths.ts";
import type { BotRecord } from "../store.ts";
import type { PromptPart } from "../system-prompt.ts";
import { capName, phoneAccess, phoneAppsFor, phoneSystemPrompt, phoneWithheldPrompt, type PhoneAccess, type PhoneBot, type PhonePlace } from "./access.ts";
import { PHONE_NO_PHONE_TEXT, PHONE_PLACE_PROMPT } from "./instructions.ts";
import { PHONE_JOB_TIMEOUT_MS, PHONE_SEND_TIMEOUT_MS, type PhoneJobs } from "./jobs.ts";
import type { PhoneRecord, PhoneRegistry } from "./registry.ts";
import { phoneRpc, type PhoneRefusal, type PhoneTarget, type PhoneToolsList } from "./rpc.ts";
import { PHONE_TOOLS, type PhoneToolResult } from "./tools.ts";

type TurnCapability = { botId: string; threadId: string; generation: string };

export interface PhoneHostDeps {
  registry: PhoneRegistry;
  jobs: PhoneJobs;
  dataDir: string;
  /** The live store bot, re-read on every check so a permission change wins over a call already under way. */
  bot(id: string): BotRecord | undefined | null;
  /** The owner whose phones a turn may use, or null when the turn is not provably the owner's. */
  turnOwner(capability: TurnCapability): string | null;
  /** True when the thread is a room, so the activity row names its author. */
  inRoom(threadId: string): boolean;
  appendMessage(threadId: string, message: Record<string, unknown>): void;
  active(capability: TurnCapability): boolean;
}

export interface PhoneHost {
  /** The owner has a phone that allows an app this bot was granted. */
  mounts(bot: PhoneBot, owner: string | null): boolean;
  integration(bot: PhoneBot, owner: string | null, mint: () => string, harnessUrl: string): { command: string; args: string[]; env: Record<string, string> } | null;
  prompt(bot: PhoneBot, owner: string | null): string;
  /** The phone part and, only beside a non-empty one, where the person is: a section of its own, volatile, so a turn
   * from the phone after one at the computer does not change the cached system prompt. */
  parts(bot: PhoneBot, owner: string | null, place: PhonePlace): [PromptPart, PromptPart];
  /** For a turn that may not use the phone although the owner's phone would serve this bot: say so, so it does not guess. */
  withheld(bot: PhoneBot, owner: string | null): string;
  handle(body: unknown, capability: TurnCapability, assertActive: () => void): Promise<PhoneToolsList | PhoneToolResult>;
  /** The PHONE_* names for the per-bot tool grants picker (/api/connectors/tools); null when no phone is registered. */
  toolListing(): { phone: Array<{ name: string; description: string }> } | null;
}

const NOT_OWNER_TEXT = "This conversation can't use a phone: only the owner's own turns can.";
const GONE_TEXT = "This bot no longer exists.";

/** The default phone: used ones first, the latest use first; then never-used ones, the newest pairing first. The poll
 * heartbeat (`seen`) never ranks: a phone that merely polled must not take a send meant for the one in use. */
const byUse = (a: PhoneRecord, b: PhoneRecord) =>
  a.lastUsedAt !== null && b.lastUsedAt !== null ? b.lastUsedAt - a.lastUsedAt
    : a.lastUsedAt !== null ? -1 : b.lastUsedAt !== null ? 1 : b.registeredAt - a.registeredAt;
const allows = (phone: PhoneRecord, cap: PhoneCapability) => Boolean(phone.registration.capabilities[cap]);
const target = (phone: PhoneRecord): PhoneTarget => ({ key: phone.key, name: phone.registration.name, platform: phone.registration.platform });
const notAllowed = (phone: string, name: PhoneToolName): PhoneRefusal =>
  ({ ok: false, code: "denied", text: `${phone} does not allow ${capName(phoneToolCapability(name))}.` });
const denied = (name: string, text: string, rule: string, summary: string): PhoneAccess =>
  ({ ok: false, text, rows: [{ tool: name, summary, decision: "auto-denied", rule }] });

export function createPhoneHost(deps: PhoneHostDeps): PhoneHost {
  const { registry, jobs } = deps;
  /** The owner's phones that allow at least one app, in default order. */
  const phonesOf = (owner: string) => registry.forOwner(owner)
    .filter((phone) => Object.values(phone.registration.capabilities).some(Boolean))
    .sort(byUse);
  /** The apps any of the owner's phones allows: what exists for the verdict. The chosen phone's own apps decide the pick. */
  const merged = (phones: PhoneRecord[]) => Object.assign({}, ...phones.map((phone) => phone.registration.capabilities)) as Partial<Record<PhoneCapability, string>>;
  const mounts = (bot: PhoneBot, owner: string | null) => {
    if (owner === null) return false;
    const grants = phoneAppsFor(bot);
    const granted = (Object.keys(grants) as PhoneCapability[]).filter((cap) => grants[cap]);
    return phonesOf(owner).some((phone) => granted.some((cap) => allows(phone, cap)));
  };
  const prompt = (bot: PhoneBot, owner: string | null) => (owner === null ? "" : phoneSystemPrompt(bot, phonesOf(owner).map(({ registration }) => registration)));
  return {
    mounts,
    integration(bot, owner, mint, harnessUrl) {
      if (!mounts(bot, owner)) return null;
      const token = mint();
      return {
        command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, PHONE_MCP_SERVER],
        env: { ...AGENTS_NODE_FLAG, [harnessMcpTokenEnv("device")]: token, OMB_HARNESS_URL: harnessUrl },
      };
    },
    prompt,
    parts(bot, owner, place) {
      const text = prompt(bot, owner);
      return [{ id: "device", label: "Phone", text }, { id: "device-place", label: "Where the person is", text: text && PHONE_PLACE_PROMPT[place] }];
    },
    withheld: (bot, owner) => (owner !== null && mounts(bot, owner) ? phoneWithheldPrompt(bot, phonesOf(owner).map(({ registration }) => registration)) : ""),
    toolListing: () => (registry.list(null, () => false).length === 0 ? null : { phone: PHONE_TOOLS.map(({ name, description }) => ({ name, description })) }),
    async handle(body, capability, assertActive) {
      return phoneRpc(body as { method?: unknown; params?: unknown }, {
        assertActive,
        // Re-read the live bot and the turn's owner on every call, so a permission change wins over a request
        // authenticated under the old one.
        authorize: (name) => {
          const bot = deps.bot(capability.botId);
          if (!bot) return { ok: false, text: GONE_TEXT };
          const owner = deps.turnOwner(capability);
          const phones = owner === null ? [] : phonesOf(owner);
          const verdict = owner === null ? denied(name, NOT_OWNER_TEXT, "phone:not-owner", "not the owner's own turn")
            : phones.length === 0 ? denied(name, PHONE_NO_PHONE_TEXT, "phone:no-phone", "no phone paired with its apps allowed")
              : phoneAccess(bot, merged(phones), name);
          for (const row of verdict.rows) {
            appendDecision(deps.dataDir, { threadId: capability.threadId, botId: bot.id, botName: bot.name, tool: row.tool, decision: row.decision, source: "connector-scope", rule: row.rule, ...(row.summary ? { summary: row.summary } : {}) });
          }
          return verdict.ok ? { ok: true } : { ok: false, text: verdict.text };
        },
        // A named phone is looked up among all of the owner's phones; the default only among those allowing the tool's app.
        phone: (preferred, name) => {
          const owner = deps.turnOwner(capability);
          const phones = owner === null ? [] : registry.forOwner(owner).sort(byUse);
          if (preferred === undefined) {
            const chosen = phones.find((phone) => allows(phone, phoneToolCapability(name)));
            return chosen ? target(chosen) : null;
          }
          if (phones.length === 0) return null;
          const wanted = preferred.trim().toLowerCase();
          const match = phones.find((phone) => phone.registration.name.trim().toLowerCase() === wanted);
          if (!match) return { ok: false, code: "no_phone", text: `${PHONE_NO_PHONE_TEXT} Available phones: ${phones.map((phone) => phone.registration.name).join(", ")}.` };
          return allows(match, phoneToolCapability(name)) ? target(match) : notAllowed(match.registration.name, name);
        },
        run: async (phone, name, args) => {
          const owner = deps.turnOwner(capability);
          const active = () => {
            if (!deps.active(capability) || owner === null || deps.turnOwner(capability) !== owner) return false;
            const bot = deps.bot(capability.botId);
            const current = registry.get(phone.key);
            return Boolean(bot && current && current.owner === owner && phoneAccess(bot, current.registration.capabilities, name).ok);
          };
          const outcome = await jobs.request(phone.key, name, args, {
            active, timeoutMs: isOutboundTool(name) ? PHONE_SEND_TIMEOUT_MS : PHONE_JOB_TIMEOUT_MS,
            offlineText: `${phone.name} is offline. Open the MausBot app on it.`, online: () => registry.online(phone.key),
          });
          if (outcome.ok) registry.used(phone.key);
          return outcome;
        },
        onWrite: (record) => {
          const bot = deps.bot(capability.botId);
          deps.appendMessage(capability.threadId, {
            role: "bot", kind: "activity",
            tool: { name: `mcp__${PHONE_MCP_SERVER}__${record.tool}`, ok: true, summary: record.summary },
            ...(bot && deps.inRoom(capability.threadId) ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
          });
        },
      });
    },
  };
}

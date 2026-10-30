import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { setLocale, t } from "@/lib/i18n";
import type { ConfigStatus } from "@/state/store";
import { WORKSPACE_CREDENTIAL_ENV } from "../../../server/credential-env.ts";
import { CREDENTIAL_TARGETS, credentialConfigPatch, desktopCredentialSlot, isConfigCredentialTarget } from "../../../shared/credential-request";
import { KEY_CATALOG, KEY_SECTIONS, keyEntry, keyForInstance, keyMatches, looksLikeOtherKey, savedState, type KeyId } from "./key-catalog";

const NOT_A_PERSONS_KEY: Record<string, string> = {
  OMB_ANTHROPIC_API_URL: "the address the Anthropic key goes to, set by a hosted install",
  OMB_HOSTED_MODEL_TOKEN: "a hosted install's model token",
  OMB_HOSTED_MODELS: "a hosted install's model list",
  OMB_COMPOSIO_BROKER_TOKEN: "MausBot Cloud's connected-apps broker",
  OMB_CLOUD_BOAT_TOKEN: "MausBot Cloud's included computers",
  OMB_CLOUD_VOICE_TOKEN: "MausBot Cloud's included voice",
  OMB_CLOUD_DECIDER_TOKEN: "MausBot Cloud's included decisions",
  OMB_CLOUD_AI_TOKEN: "MausBot Cloud's included AI",
  OMB_CLOUD_X_TOKEN: "MausBot Cloud's included X research",
  OMB_CLOUD_CONNECTED_APPS_GRANT: "MausBot Cloud's connected apps",
  OMB_BROWSER_CONNECTION: "the app's own browser, not a credential",
  OMB_USER_DATA: "the app's own data folder, not a credential",
  OMB_BOAT_API: "the Boat address, not a credential",
};

const electron = (file: string) => readFileSync(new URL(`../../../electron/${file}`, import.meta.url), "utf8");

beforeEach(() => setLocale("en"));

describe("every credential has one home on the keys page", () => {
  it("files each workspace credential under exactly one row, in one section", () => {
    for (const env of WORKSPACE_CREDENTIAL_ENV) {
      const rows = KEY_CATALOG.filter((entry) => entry.env.includes(env)).map((entry) => entry.id);
      if (env in NOT_A_PERSONS_KEY) expect(rows, env).toEqual([]);
      else expect(rows, env).toHaveLength(1);
    }
    for (const entry of KEY_CATALOG) expect(KEY_SECTIONS.map((section) => section.id)).toContain(entry.section);
    expect(new Set(KEY_CATALOG.map((entry) => entry.id)).size).toBe(KEY_CATALOG.length);
  });

  it("covers every key the desktop keeps in its encrypted store, saving the ones with a row through that store", () => {
    const stored = [...electron("workspace-credentials.mjs").matchAll(/name: "(\w+)", env: "(\w+)"/g)].map(([, name, env]) => ({ name: name!, env: env! }));
    const patched = [...electron("credential-patch.mjs").matchAll(/^ {2}(\w+): \(value\) =>/gm)].map(([, name]) => name!);
    expect(stored.length).toBeGreaterThan(10);
    for (const { name, env } of stored) {
      const home = KEY_CATALOG.find((entry) => entry.env.includes(env));
      expect(home, name).toBeDefined();
      if (home?.target) expect(home.target.slot, name).toBe(name);
    }
    const homed = (name: string) => KEY_CATALOG.some((entry) => entry.target?.slot === name)
      || stored.some((row) => row.name === name && KEY_CATALOG.some((entry) => entry.env.includes(row.env)));
    for (const name of patched) expect(homed(name), name).toBe(true);
  });

  // A key saved from a bot's card lands exactly where its Settings row puts it: the same desktop slot, or the same config.
  it("covers every credential a bot can ask for in a chat, saved where Settings saves it", () => {
    const homes: Record<keyof typeof CREDENTIAL_TARGETS, KeyId> = {
      xaiApiKey: "xai", boxToken: "box", opencodeGoApiKey: "opencodeGo", ttsKey: "elevenlabs", fishAudioKey: "fishAudio",
      openaiImageApiKey: "imageOpenai", onePasswordToken: "onePassword", composioApiKey: "composio", openaiApiKey: "openai",
      anthropicApiKey: "anthropic", openrouterApiKey: "openrouter", mistralApiKey: "mistral", cerebrasApiKey: "cerebras", groqApiKey: "groq",
      metaApiKey: "meta", deepseekApiKey: "deepseek",
    };
    expect(Object.keys(homes).sort()).toEqual(Object.keys(CREDENTIAL_TARGETS).sort());
    for (const [name, id] of Object.entries(homes) as Array<[keyof typeof CREDENTIAL_TARGETS, KeyId]>) {
      const entry = keyEntry(id);
      if (!entry.target) {
        expect(entry.opens, name).toBe("logins");
        expect(desktopCredentialSlot(name), name).toBeNull();
        continue;
      }
      expect(desktopCredentialSlot(name), name).toBe(entry.target.slot ?? null);
      if (isConfigCredentialTarget(name)) expect(credentialConfigPatch(name, "k"), name).toEqual(entry.target.patch("k", true));
    }
  });

  it("names each section plainly and says what each row is for in one line", () => {
    expect(KEY_SECTIONS.map((section) => t(section.titleKey))).toEqual([
      "AI providers", "Your own model servers", "Voice and calls", "Computers and browser", "Apps and tools", "Helpers and pictures",
    ]);
    for (const entry of KEY_CATALOG) {
      const purpose = t(entry.purposeKey);
      expect(purpose, entry.id).not.toBe(entry.purposeKey);
      expect(purpose, entry.id).not.toContain("\n");
      expect(purpose.length, entry.id).toBeLessThanOrEqual(80);
    }
    for (const section of KEY_SECTIONS) expect(KEY_CATALOG.some((entry) => entry.section === section.id), section.id).toBe(true);
  });

  it("keeps the OpenAI key once: live calls point at it instead of holding a copy", () => {
    const live = keyEntry("liveCalls");
    expect(live).toMatchObject({ section: "voice", kind: "uses", uses: "openai" });
    expect(live.target).toBeUndefined();
    expect(live.env).toEqual([]);
    const config = { openai: { configured: true, last4: "a1b2" } } as ConfigStatus;
    expect(savedState(live, config)).toEqual({ configured: true, last4: "a1b2" });
    expect(t(live.labelKey)).toBe("OpenAI key");
    expect(t(keyEntry("openai").labelKey)).toBe("OpenAI API key");
  });
});

describe("searching the keys", () => {
  const found = (query: string) => KEY_CATALOG.filter((entry) => keyMatches(entry, query)).map((entry) => entry.id);

  it("matches a provider's name, what the key is for, and its section's title", () => {
    expect(found("fish")).toEqual(["fishAudio"]);
    expect(found("ElevenLabs")).toEqual(["elevenlabs"]);
    expect(found("Computers and browser")).toEqual(["box", "vps", "onePassword"]);
    expect(found("voice")).toEqual(expect.arrayContaining(["liveCalls", "liveKey", "elevenlabs", "fishAudio"]));
    expect(found("openai")).toEqual(expect.arrayContaining(["openai", "liveCalls", "liveKey", "imageOpenai"]));
    expect(found("gmail")).toEqual(["composio"]);
    expect(found("no such key anywhere")).toEqual([]);
  });
});

describe("a key pasted into the wrong row", () => {
  it("names the provider the key belongs to", () => {
    expect(looksLikeOtherKey(keyEntry("openai"), "sk-ant-api03-abcdefghijkl")?.id).toBe("anthropic");
    expect(looksLikeOtherKey(keyEntry("box"), "sk-proj-abcdefghijkl")?.id).toBe("openai");
    expect(looksLikeOtherKey(keyEntry("liveCalls"), "gsk_abcdefghijkl")?.id).toBe("groq");
    expect(looksLikeOtherKey(keyEntry("composio"), "boat_abcdefghijkl")?.id).toBe("box");
  });

  it("stays quiet for the row's own key and for keys with no telling shape", () => {
    expect(looksLikeOtherKey(keyEntry("openai"), "sk-proj-abcdefghijkl")).toBeNull();
    expect(looksLikeOtherKey(keyEntry("imageOpenai"), "sk-proj-abcdefghijkl")).toBeNull();
    expect(looksLikeOtherKey(keyEntry("deepseek"), "sk-plain-legacy-shaped-key")).toBeNull();
    expect(looksLikeOtherKey(keyEntry("mistral"), "a-key-with-no-prefix")).toBeNull();
    expect(looksLikeOtherKey(keyEntry("openai"), "")).toBeNull();
  });
});

describe("engines that run on a key", () => {
  it("find the row that holds their key", () => {
    expect(keyForInstance("claudeApi")).toBe("anthropic");
    expect(keyForInstance("xaiApi")).toBe("xai");
    expect(keyForInstance("deepseek")).toBe("deepseek");
    expect(keyForInstance("claude")).toBeUndefined();
    expect(keyForInstance(undefined)).toBeUndefined();
  });
});

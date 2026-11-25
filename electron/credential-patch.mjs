import nativeText from "./native-text.cjs";
export const CREDENTIAL_PATCH = {
  openaiApiKey: (value) => ({ openai: { key: value } }),
  // everyClaudeBot travels with the key, so no moment exists where a first key moves every signed-in Claude bot onto API billing.
  anthropicApiKey: (value, options) => ({ anthropic: { key: value, ...(options?.everyClaudeBot === false ? { everyClaudeBot: false } : {}) } }),
  openrouterApiKey: (value) => ({ openrouter: { key: value } }),
  mistralApiKey: (value) => ({ mistral: { key: value } }),
  cerebrasApiKey: (value) => ({ cerebras: { key: value } }),
  groqApiKey: (value) => ({ groq: { key: value } }),
  greenferenceApiKey: (value) => ({ greenference: { key: value } }),
  modelgoApiKey: (value) => ({ modelgo: { key: value } }),
  metaApiKey: (value) => ({ meta: { key: value } }),
  deepseekApiKey: (value) => ({ deepseek: { key: value } }),
  openaiCompatApiKey: (value) => ({ openaiCompat: { key: value } }),
  composioApiKey: (value) => ({ composio: { apiKey: value } }),
  xaiApiKey: (value) => ({ xai: { key: value } }),
  boxToken: (value) => ({ box: { token: value } }),
  opencodeGoApiKey: (value) => ({ opencodeGo: { apiKey: value } }),
  ttsKey: (value) => ({ tts: { key: value } }),
  fishAudioKey: (value) => ({ tts: { fishKey: value } }),
  geminiTtsKey: (value) => ({ tts: { geminiKey: value } }),
  jevApiKey: (value) => ({ decider: { key: value } }),
  openrouterDeciderKey: (value) => ({ decider: { openrouterKey: value } }),
  workersAiToken: (value) => ({ decider: { workersAiToken: value } }),
  customDeciderKey: (value) => ({ decider: { customKey: value } }),
  openaiImageApiKey: (value) => ({ imageGen: { key: value } }),
  customImageApiKey: (value) => ({ imageGen: { customApiKey: value } }),
  geminiImageApiKey: (value) => ({ imageGen: { geminiKey: value } }),
  openaiLiveKey: (value) => ({ live: { key: value } }),
  tregApiKey: (value) => ({ treg: { key: value } }),
  postizApiKey: (value) => ({ postiz: { key: value } }),
};

/** The providers a paired phone may set a key for, by credential name. Never openaiCompat: its patch carries the URL the key goes to. */
const PHONE_KEY_CREDENTIALS = Object.freeze({
  openai: "openaiApiKey",
  anthropic: "anthropicApiKey",
  openrouter: "openrouterApiKey",
  mistral: "mistralApiKey",
  cerebras: "cerebrasApiKey",
  groq: "groqApiKey",
  greenference: "greenferenceApiKey",
  modelgo: "modelgoApiKey",
  meta: "metaApiKey",
  xai: "xaiApiKey",
});

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** A phone's `PUT /api/config` body as the one credential:set call it stands for, or null when it is anything but one provider's key. */
export function phoneKeyCredential(patch) {
  if (!isRecord(patch)) return null;
  const providers = Object.keys(patch);
  if (providers.length !== 1 || !Object.hasOwn(PHONE_KEY_CREDENTIALS, providers[0])) return null;
  const provider = providers[0];
  const entry = patch[provider];
  const fields = provider === "anthropic" ? ["key", "everyClaudeBot"] : ["key"];
  if (!isRecord(entry) || !Object.hasOwn(entry, "key") || typeof entry.key !== "string" || !Object.keys(entry).every((field) => fields.includes(field))) return null;
  if (Object.hasOwn(entry, "everyClaudeBot") && typeof entry.everyClaudeBot !== "boolean") return null;
  return {
    name: PHONE_KEY_CREDENTIALS[provider],
    value: entry.key,
    options: Object.hasOwn(entry, "everyClaudeBot") ? { everyClaudeBot: entry.everyClaudeBot } : undefined,
  };
}

/** The desktop's credential save has two callers: its own Settings (credential:set) and a paired phone's key, which takes
 * the same save so it persists, and clears, exactly like one set here. The phone saver resolves `{ status, body }`. */
export function serveCredentialSaves({ ipcMain, localOnly, setPhoneSaver, save }) {
  ipcMain.handle("credential:set", localOnly("credential:set", (_event, name, value, options) => save(name, value, options)));
  setPhoneSaver(async (patch) => {
    const credential = phoneKeyCredential(patch);
    if (!credential) return { status: 403, body: { error: "From a phone, only API keys can be changed. Change other settings on your computer." } };
    try {
      return { status: 200, body: await save(credential.name, credential.value, credential.options) };
    } catch (error) {
      return { status: Number.isInteger(error?.status) ? error.status : 503, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  });
}

const DECIDER_ERRORS = Object.freeze({
  "serverError.decider.accountRequired": "native.decider.accountRequired",
  "serverError.decider.jevRejected": "native.decider.jevRejected",
  "serverError.decider.workersRejected": "native.decider.workersRejected",
  "serverError.decider.routerRejected": "native.decider.routerRejected",
});

/** Electron 43's ipcMain.handle sends a thrown error to the page as its toString(), so a key the provider refused travels as its name. */
export function credentialSaveError(status, body, t = nativeText.englishText.t) {
  const key = Object.hasOwn(DECIDER_ERRORS, body?.errorKey) ? DECIDER_ERRORS[body.errorKey] : undefined;
  const message = key && body?.error === nativeText.englishText.t(key) ? t(key) : body?.error;
  const error = new Error(message || `Could not save credential (HTTP ${status})`);
  if (body?.code === "key_rejected") error.name = "KeyRejected";
  error.status = status;
  return error;
}

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
  openaiImageApiKey: (value) => ({ imageGen: { key: value } }),
  customImageApiKey: (value) => ({ imageGen: { customApiKey: value } }),
  geminiImageApiKey: (value) => ({ imageGen: { geminiKey: value } }),
  openaiLiveKey: (value) => ({ live: { key: value } }),
  tregApiKey: (value) => ({ treg: { key: value } }),
  postizApiKey: (value) => ({ postiz: { key: value } }),
};

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
  return error;
}

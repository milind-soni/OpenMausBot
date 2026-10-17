// What saving a credential from the desktop changes in the server config, by credential name.
export const CREDENTIAL_PATCH = {
  composioApiKey: (value) => ({ composio: { apiKey: value } }),
  xaiApiKey: (value) => ({ xai: { key: value } }),
  boxToken: (value) => ({ box: { token: value } }),
  opencodeGoApiKey: (value) => ({ opencodeGo: { apiKey: value } }),
  ttsKey: (value) => ({ tts: { key: value } }),
  fishAudioKey: (value) => ({ tts: { fishKey: value } }),
  jevApiKey: (value) => ({ decider: { key: value } }),
  openrouterDeciderKey: (value) => ({ decider: { openrouterKey: value } }),
  openaiImageApiKey: (value) => ({ imageGen: { key: value } }),
  customImageApiKey: (value) => ({ imageGen: { customApiKey: value } }),
  openaiLiveKey: (value) => ({ live: { key: value } }),
  tregApiKey: (value) => ({ treg: { key: value } }),
};

/** Electron 43's ipcMain.handle sends a thrown error to the page as its toString(), so a key the provider refused travels as its name. */
export function credentialSaveError(status, body) {
  const error = new Error(body?.error || `Could not save credential (HTTP ${status})`);
  if (body?.code === "key_rejected") error.name = "KeyRejected";
  return error;
}

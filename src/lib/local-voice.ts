// Voice output selected on a paired desktop belongs to that device, not the
// remote host. A Mac client can therefore use its installed voices while a
// Windows host independently uses ElevenLabs for its own playback.
export type RemoteVoiceProvider = "host" | "system";

type Preferences = {
  provider?: RemoteVoiceProvider;
  voices?: Record<string, string>;
};

const STORAGE_KEY = "openmausbot.remote-voice.v1";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read(): Preferences {
  try {
    const value = storage()?.getItem(STORAGE_KEY);
    if (!value) return {};
    const parsed = JSON.parse(value) as Preferences;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function write(next: Preferences): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A locked-down renderer may reject storage. Voice still works for the
    // current default; persistence is a convenience, not a prerequisite.
  }
}

export function localSystemVoicesAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    window.ogb?.remoteClient?.active === true &&
    window.ogb?.platform === "darwin" &&
    typeof window.speechSynthesis !== "undefined" &&
    typeof window.SpeechSynthesisUtterance !== "undefined"
  );
}

export function remoteVoiceProvider(): RemoteVoiceProvider {
  const provider = read().provider;
  // A paired Mac defaults to its private, installed voices. Choosing Host
  // voice is explicit and remains independent from the host's own setting.
  return provider === "host" ? "host" : "system";
}

export function setRemoteVoiceProvider(provider: RemoteVoiceProvider): void {
  write({ ...read(), provider });
}

export function remoteSystemVoice(botId?: string): string {
  if (!botId) return "";
  return read().voices?.[botId] ?? "";
}

export function setRemoteSystemVoice(botId: string, voiceId: string): void {
  const current = read();
  write({
    ...current,
    voices: {
      ...current.voices,
      [botId]: voiceId,
    },
  });
}

export function localSystemVoiceActive(): boolean {
  return localSystemVoicesAvailable() && remoteVoiceProvider() === "system";
}

export type LocalSystemVoice = {
  id: string;
  label: string;
  description?: string;
};

export function listLocalSystemVoices(): LocalSystemVoice[] {
  if (!localSystemVoicesAvailable()) return [];
  return window.speechSynthesis.getVoices().map((voice) => ({
    id: voice.voiceURI,
    label: voice.name,
    description: voice.lang || undefined,
  }));
}

export function resolveLocalSystemVoice(voiceId: string): SpeechSynthesisVoice | null {
  if (!localSystemVoicesAvailable() || !voiceId) return null;
  return (
    window.speechSynthesis
      .getVoices()
      .find((voice) => voice.voiceURI === voiceId || voice.name === voiceId) ?? null
  );
}

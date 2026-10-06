// Keep whisper codes aligned with shared/dictation-languages.ts.
export const WHISPER_CODES = new Set([
  "auto", "en", "he", "es", "fr", "de", "pt", "it", "nl", "ru", "ar", "hi", "zh", "ja", "ko", "tr", "pl",
]);

export const WHISPER_MODEL = {
  id: "whisper-large-v3-turbo",
  label: "Whisper Large v3 Turbo",
  fileName: "ggml-large-v3-turbo.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
};

const RELEASE = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.7";

/** CPU build of whisper.cpp for this desktop. Mac dictation stays on Apple speech. */
export function binaryAsset(platform, arch) {
  if (platform === "win32" && arch === "x64") {
    return { file: "whisper-bin-x64.zip", url: `${RELEASE}/whisper-bin-x64.zip` };
  }
  if (platform === "linux" && arch === "x64") {
    return { file: "whisper-bin-ubuntu-x64.tar.gz", url: `${RELEASE}/whisper-bin-ubuntu-x64.tar.gz` };
  }
  if (platform === "linux" && arch === "arm64") {
    return { file: "whisper-bin-ubuntu-arm64.tar.gz", url: `${RELEASE}/whisper-bin-ubuntu-arm64.tar.gz` };
  }
  return null;
}

export function whisperLanguage(code) {
  return WHISPER_CODES.has(code) ? code : "auto";
}

/** A BCP-47 tag safe to pass as one argv entry. Anything else is omitted. */
export function speechLocale(value) {
  if (typeof value !== "string") return "";
  const locale = value.trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(locale)) return "";
  return locale;
}

export const DEEPSEEK_HARNESS_MAX_TOKEN_LIMIT = 10_000_000;

export const DEEPSEEK_HARNESS_PUBLIC_ERROR_CODES = [
  "settings-busy",
  "invalid-request",
  "invalid-base-url",
  "pairing-required",
  "pairing-unavailable",
  "pairing-rejected",
  "host-unavailable",
  "paired-device-unauthorized",
  "paired-plugin-update-required",
  "provider-not-eligible",
  "model-update-conflict",
  "model-update-rejected",
  "invalid-response",
  "request-failed",
] as const;

export type DeepSeekHarnessPublicErrorCode = typeof DEEPSEEK_HARNESS_PUBLIC_ERROR_CODES[number];

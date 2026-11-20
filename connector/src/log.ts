// One line per event on stdout (docker logs). Every secret the connector holds is registered here and replaced in any
// line that would carry it, so a value never reaches a log even through an error message.

const secrets = new Set<string>();

export function clearSecrets(): void {
  secrets.clear();
}

export function registerSecret(value: string | undefined | null): void {
  if (!value || typeof value !== "string" || value.length < 8) return;
  secrets.add(value);
  try {
    const urlEncoded = encodeURIComponent(value);
    if (urlEncoded.length >= 8) secrets.add(urlEncoded);
  } catch {
    // Malformed URI component ignored
  }
  try {
    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    if (jsonEscaped.length >= 8) secrets.add(jsonEscaped);
  } catch {
    // Invalid JSON escaped ignored
  }
}

export function registerHomeSecrets(env: Record<string, string>): void {
  for (const [name, value] of Object.entries(env)) {
    if (/(?:SECRET|TOKEN|GRANT|KEY|PASSWORD)$/.test(name)) {
      registerSecret(value);
    }
  }
}

export function redact(text: string): string {
  if (!text || secrets.size === 0) return text;
  let out = text;
  const sorted = Array.from(secrets).sort((a, b) => b.length - a.length);
  for (const secret of sorted) {
    if (out.includes(secret)) out = out.split(secret).join("[secret]");
  }
  return out;
}

export interface RedactedErrorInfo {
  name: string;
  message: string;
  code?: string | number;
  stack?: string;
}

export function redactError(error: unknown): RedactedErrorInfo {
  let name = "Error";
  let message = "";
  let code: string | number | undefined;
  let stack: string | undefined;

  if (error instanceof Error) {
    name = redact(error.name || "Error");
    message = redact(error.message || "");
    if ("code" in error && (typeof (error as Record<string, unknown>).code === "string" || typeof (error as Record<string, unknown>).code === "number")) {
      code = (error as Record<string, unknown>).code as string | number;
    }
    if (error.stack) {
      stack = redact(error.stack);
    }
  } else if (typeof error === "string") {
    message = redact(error);
  } else if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    name = typeof obj.name === "string" ? redact(obj.name) : "Error";
    message = typeof obj.message === "string" ? redact(obj.message) : redact(String(error));
    if (typeof obj.code === "string" || typeof obj.code === "number") code = obj.code;
    if (typeof obj.stack === "string") stack = redact(obj.stack);
  } else {
    message = redact(String(error));
  }

  return {
    name,
    message,
    ...(code !== undefined ? { code } : {}),
    ...(stack !== undefined ? { stack } : {}),
  };
}

export type Log = (line: string) => void;

export const log: Log = (line) => {
  process.stdout.write(`${new Date().toISOString()} ${redact(line)}\n`);
};

export function errorText(error: unknown): string {
  return redactError(error).message;
}

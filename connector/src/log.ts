// One line per event on stdout (docker logs). Every secret the connector holds is registered here and replaced in any
// line that would carry it, so a value never reaches a log even through an error message.

const secrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join("[secret]");
  return out;
}

export type Log = (line: string) => void;

export const log: Log = (line) => {
  process.stdout.write(`${new Date().toISOString()} ${redact(line)}\n`);
};

export function errorText(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

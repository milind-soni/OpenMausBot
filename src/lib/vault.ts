import type { LoginBots, LoginSummary, OnePasswordStatus } from "../../shared/logins";
import type { LinkedSecret, VaultChoice, VaultSecret } from "../../shared/vault";
import type { ComputerHelpRef } from "../../shared/wire";
import { api } from "@/state/store";

// A saved value is sent once and never comes back: every answer here is names, sites and who may use them.

export interface VaultList {
  logins: LoginSummary[];
  secrets: Array<VaultSecret | LinkedSecret>;
  onePassword: OnePasswordStatus;
}

export async function listVault(): Promise<VaultList> {
  return await api<VaultList>("/api/vault");
}

export async function addSecret(name: string, value: string, bots: LoginBots): Promise<VaultSecret> {
  return (await api<{ secret: VaultSecret }>("/api/vault/secrets", { method: "POST", body: JSON.stringify({ name, value, bots }) })).secret;
}

/** An empty value keeps the saved one. */
export async function changeSecret(id: string, change: { name?: string; value?: string; bots?: LoginBots }): Promise<VaultSecret> {
  return (await api<{ secret: VaultSecret }>(`/api/vault/secrets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ ...(change.name ? { name: change.name } : {}), ...(change.value?.trim() ? { value: change.value } : {}), ...(change.bots ? { bots: change.bots } : {}) }),
  })).secret;
}

/** The MCP servers that lost their key with it. */
export async function deleteSecret(id: string): Promise<string[]> {
  return (await api<{ keysOff?: string[] }>(`/api/vault/secrets/${encodeURIComponent(id)}`, { method: "DELETE" })).keysOff ?? [];
}

/** The NAME=value lines of a pasted .env file. `export`, quotes and trailing comments are dropped; a later line with the
 * same name wins, and a line with no value is skipped. */
export function parseEnv(text: string): Array<{ name: string; value: string }> {
  const found = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (!match) continue;
    const raw = match[2]!;
    const quoted = /^(["'`])(.*)\1$/su.exec(raw);
    const value = quoted ? (quoted[1] === '"' ? quoted[2]!.replace(/\\n/gu, "\n").replace(/\\(["\\])/gu, "$1") : quoted[2]!) : raw.replace(/\s+#.*$/u, "").trim();
    if (value) found.set(match[1]!, value);
  }
  return [...found].map(([name, value]) => ({ name, value }));
}

/** Saves each line as a secret; stops at the first one the server refuses, naming it. */
export async function importEnv(lines: ReadonlyArray<{ name: string; value: string }>, bots: LoginBots): Promise<number> {
  let saved = 0;
  for (const { name, value } of lines) {
    try { await addSecret(name, value, bots); saved++; }
    catch (cause) { throw new Error(`${name}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  return saved;
}

type CardRef = Pick<ComputerHelpRef, "botId" | "threadId" | "messageId">;
export type ChoiceKind = "secret" | "login";

const cardPath = (kind: ChoiceKind, ref: CardRef, end: "list" | "use") =>
  `/api/bots/${encodeURIComponent(ref.botId)}/${kind === "secret" ? "secret-cards" : "sign-in-cards"}/${encodeURIComponent(ref.messageId)}/${
    kind === "secret" ? (end === "list" ? "saved" : "use") : (end === "list" ? "saved-logins" : "use-login")}`;

/** What a secure card offers under "Use a saved one", by name only. Empty where this person can't change the Vault. */
export async function savedChoices(kind: ChoiceKind, ref: CardRef): Promise<VaultChoice[]> {
  return (await api<{ choices: VaultChoice[] }>(`${cardPath(kind, ref, "list")}?threadId=${encodeURIComponent(ref.threadId)}`)).choices;
}

/** The bot may use the one picked from now on, and the card is answered with it. */
export async function useSaved(kind: ChoiceKind, ref: CardRef, id: string): Promise<void> {
  await api(cardPath(kind, ref, "use"), { method: "POST", body: JSON.stringify({ threadId: ref.threadId, ...(kind === "secret" ? { itemId: id } : { loginId: id }) }) });
}

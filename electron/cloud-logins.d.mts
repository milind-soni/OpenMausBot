export type HandoffWhat = { kind: "1password" } | { kind: "login"; id: string };
/** A move's ask for one connection's secrets, a code for the person's Cloud, letting go of a sign-in that moved, or
 * every credential's fingerprint under a nonce, which checks what a move carried without a secret leaving. */
export type ConnectionAsk = { kind: "connection"; id: string } | { kind: "composio-share"; for: string } | { kind: "connection-release"; id: string; digest: string }
  | { kind: "verify-secrets"; nonce: string };

interface PrivateProcess { postMessage(message: unknown): void }

export function botsOnCloud(bots: unknown, cloudBotIds: ReadonlySet<string>): "all" | string[];
export function createLoginHandoffClient(options?: { timeoutMs?: number; randomId?: () => string }): {
  request(proc: PrivateProcess | null | undefined, what: HandoffWhat | ConnectionAsk): Promise<{
    onePassword?: { token: string; grants: Record<string, unknown> }; login?: Record<string, unknown>;
    connection?: Record<string, any>; digest?: string; share?: { code: string }; release?: { released?: true; changed?: true };
    secrets?: Record<string, string>;
  }>;
  receive(proc: unknown, message: unknown): boolean;
};

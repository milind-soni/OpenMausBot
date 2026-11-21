// Kept apart from config.json so a pasted or exported config never carries a token; a token never follows its entry to another URL.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

const tokensSchema = z.object({
  access: z.string().min(1),
  refresh: z.string().min(1).optional(),
  expiresAt: z.number().optional(),
  scope: z.string().optional(),
});

const recordSchema = z.object({
  url: z.string(),
  state: z.enum(["needs-sign-in", "signed-in"]),
  issuer: z.string().optional(),
  clientId: z.string().optional(),
  /** Only a secret the server issued at dynamic registration. A configured app's secret stays in config.json and is
   * never kept here. */
  clientSecret: z.string().optional(),
  tokenAuth: z.enum(["client_secret_post", "client_secret_basic"]).optional(),
  redirectUri: z.string().optional(),
  tokenEndpoint: z.string().optional(),
  revocationEndpoint: z.string().optional(),
  tokens: tokensSchema.optional(),
});

const fileSchema = z.object({
  servers: z.record(z.string(), recordSchema).default({}),
  /** Refresh tokens already sent to a token endpoint, per server. Presenting one of them again can be a replay, so the
   * mark is kept here and not in memory: a restart must not present it either. */
  spentRefresh: z.record(z.string(), z.string().min(1)).default({}),
});

export type McpOAuthTokens = z.infer<typeof tokensSchema>;
export type McpOAuthRecord = z.infer<typeof recordSchema>;
/** The file as it is kept on disk. Both maps are always present: the schema fills the missing one in. */
interface StoreFile {
  servers: Record<string, McpOAuthRecord>;
  spentRefresh: Record<string, string>;
}

/** One sign-in as this store keeps it, from anywhere else (a sign-in moved from the person's own computer); null if not. */
export function parseMcpOAuthRecord(value: unknown): McpOAuthRecord | null {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export class McpOAuthStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  get(name: string, url: string): McpOAuthRecord | undefined {
    const record = this.read().servers[name];
    return record && record.url === url ? record : undefined;
  }

  put(name: string, record: McpOAuthRecord): void {
    const data = this.read();
    data.servers[name] = recordSchema.parse(record);
    this.write(data);
  }

  delete(name: string): void {
    const data = this.read();
    if (!Object.hasOwn(data.servers, name) && !Object.hasOwn(data.spentRefresh, name)) return;
    delete data.servers[name];
    delete data.spentRefresh[name];
    this.write(data);
  }

  /** Forget the refresh token marked as spent for this server: a new sign-in brings a new token. */
  forgetSpentRefresh(name: string): void {
    const data = this.read();
    if (!Object.hasOwn(data.spentRefresh, name)) return;
    delete data.spentRefresh[name];
    this.write(data);
  }

  /** The refresh token already sent for this server, when presenting it again could be a replay. */
  spentRefreshFor(name: string): string | undefined {
    return this.read().spentRefresh[name];
  }

  /** Remember a refresh token that has been sent, before its answer arrives: a lost answer may mean the server
   * rotated it, and a restart must not present it again. */
  markSpentRefresh(name: string, token: string): void {
    const data = this.read();
    data.spentRefresh = { ...data.spentRefresh, [name]: token };
    this.write(data);
  }

  /** Forget a sent refresh token once the server has answered and kept it: it is still valid. */
  clearSpentRefresh(name: string, token: string): void {
    const data = this.read();
    if (data.spentRefresh[name] !== token) return;
    delete data.spentRefresh[name];
    this.write(data);
  }

  // Read through on every call: another process may have changed the file.
  private read(): StoreFile {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
    }
    return { servers: {}, spentRefresh: {} };
  }

  private write(data: StoreFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}

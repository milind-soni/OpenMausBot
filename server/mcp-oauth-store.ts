// Sign-in state for URL MCP servers, kept apart from config.json so a
// pasted or exported config never carries a token. One owner-only file:
// per server, the URL it was signed in for (a token never follows the
// entry to another address), the client it signed in as, and its tokens.
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
  /** How a pre-registered app with a secret proves itself at the token
   * endpoint. The secret stays in config.json; it is never kept here. */
  tokenAuth: z.enum(["client_secret_post", "client_secret_basic"]).optional(),
  redirectUri: z.string().optional(),
  tokenEndpoint: z.string().optional(),
  revocationEndpoint: z.string().optional(),
  tokens: tokensSchema.optional(),
});

const fileSchema = z.object({
  servers: z.record(z.string(), recordSchema).default({}),
});

export type McpOAuthTokens = z.infer<typeof tokensSchema>;
export type McpOAuthRecord = z.infer<typeof recordSchema>;
type StoreFile = z.infer<typeof fileSchema>;

export class McpOAuthStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** The record for this server, only while it is still for this URL. */
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
    if (!Object.hasOwn(data.servers, name)) return;
    delete data.servers[name];
    this.write(data);
  }

  // Read through on every call: the file is small, and another process
  // (the config CLI, a second window's server) may have changed it.
  private read(): StoreFile {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      // missing or unreadable: empty until the next write
    }
    return { servers: {} };
  }

  private write(data: StoreFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}

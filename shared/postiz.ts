// Postiz (postiz.com), the social media scheduler, through its own MCP server. OpenMausBot only calls Postiz's public
// MCP and OAuth endpoints: Postiz is AGPL-3.0 and none of its code is copied here.

/** The MCP server name bots see the Postiz tools under (`mcp__postiz__…` on Claude Code). */
export const POSTIZ_SERVER = "postiz";

/** Postiz Cloud's backend, as its published OAuth metadata names it (checked 2026-10-29). */
export const POSTIZ_CLOUD = "https://api.postiz.com";

/** Where a Postiz organisation API key comes from. */
export const POSTIZ_KEY_PAGE = "https://platform.postiz.com/settings";

/** GET /api/postiz. Never a key or a token. */
export interface PostizStatus {
  /** `taken`: an MCP server named postiz that this card did not set up; `blocked`: the organization's policy refuses it. */
  state: "not-connected" | "connected" | "needs-sign-in" | "key-refused" | "taken" | "blocked";
  /** How the connection signs in: Postiz Cloud's own sign-in, or an organisation API key. */
  how: "sign-in" | "key" | null;
  /** The Postiz server the key belongs to: Postiz Cloud unless the person entered their own. */
  address: string;
  /** Its host, as the card shows it. */
  host: string;
  selfHosted: boolean;
  /** A key is saved (on this server, or in the desktop's encrypted store). */
  keySaved: boolean;
  /** A Team Cloud: `person` means each person connects their own Postiz. */
  team: boolean;
  scope: "team" | "person";
  /** Tools the last check found. */
  tools?: number;
  /** Why the organization's policy refuses it, for `blocked`. */
  message?: string;
}

export function isPostizStatus(value: unknown): value is PostizStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<PostizStatus>;
  return typeof status.state === "string" && typeof status.address === "string" && typeof status.host === "string"
    && (status.how === null || status.how === "sign-in" || status.how === "key");
}

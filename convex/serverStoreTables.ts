import { defineTable } from "convex/server";
import { v } from "convex/values";

// State the Next frontend used to keep in ORIGIN_LOCAL_DATA_DIR (origin.sqlite, integrations.sqlite, execution.sqlite and
// key files). The frontend is stateless: it reaches these tables only through the signed /integrations HTTP action
// (convex/serverStore.ts, convex/mcpOAuth.ts) or the session-checked chat and call functions (workspaceChat.ts,
// workspaceCalls.ts). Every secret is sealed with ORIGIN_SEALING_KEY (convex/lib/sealing.ts); tokens the frontend issues
// are stored as SHA-256 hashes only.
// Chat and call signaling reuse the existing teamChat*/teamCall* tables in realtimeTables.ts.

export const serverStoreTables = {
  /** Fixed-window request counters shared by every frontend instance (was request_limits in origin.sqlite). */
  requestLimits: defineTable({ key: v.string(), count: v.number(), expiresAt: v.number() })
    .index("by_key", ["key"])
    .index("by_expiresAt", ["expiresAt"]),

  /** Short exclusive leases, e.g. one GitHub token refresh at a time (was execution_locks and in-process maps). */
  serverLeases: defineTable({ name: v.string(), owner: v.string(), expiresAt: v.number() })
    .index("by_name", ["name"])
    .index("by_expiresAt", ["expiresAt"]),

  /** The instance's GitHub App registered with the manifest flow; sealed JSON, purpose "github-app" (was github_app). */
  githubAppRegistrations: defineTable({ slot: v.literal("default"), sealed: v.string(), createdAt: v.number() })
    .index("by_slot", ["slot"]),

  /** A project's own GitHub token; sealed, purpose `github-connection:<projectId>:<repo>` (was github_connections). */
  githubProjectConnections: defineTable({
    projectId: v.id("projects"),
    repo: v.string(),
    login: v.string(),
    sealed: v.string(),
    connectedBy: v.id("users"),
    updatedAt: v.number(),
  }).index("by_projectId", ["projectId"]),

  /** A workspace's GitHub user token from the App's OAuth flow; sealed, purpose `github-team:<teamId>` (was github_workspace). */
  githubWorkspaceConnections: defineTable({
    teamId: v.id("teams"),
    login: v.string(),
    accountId: v.number(),
    connectedBy: v.id("users"),
    sealed: v.string(),
    /** Bumped on every write of `sealed`, so a token refresh never overwrites a reconnect. */
    version: v.number(),
    updatedAt: v.number(),
  }).index("by_teamId", ["teamId"]),

  /** Pending GitHub OAuth/manifest requests, keyed by the SHA-256 of the state and browser nonce (was github_oauth_states). */
  githubOAuthStates: defineTable({ stateHash: v.string(), browserHash: v.string(), sealed: v.string(), expiresAt: v.number() })
    .index("by_stateHash", ["stateHash"])
    .index("by_expiresAt", ["expiresAt"]),

  /** Idempotency markers and leases for GitHub side effects and sync cursors (was github_jobs). */
  githubJobs: defineTable({ key: v.string(), state: v.string(), payload: v.optional(v.string()), updatedAt: v.number() })
    .index("by_key", ["key"]),

  /** OAuth 2.1 public clients registered for the MCP endpoint (was mcp_clients). */
  mcpOAuthClients: defineTable({ clientId: v.string(), name: v.string(), redirects: v.string(), createdAt: v.number() })
    .index("by_clientId", ["clientId"])
    .index("by_name_and_redirects", ["name", "redirects"])
    .index("by_createdAt", ["createdAt"]),

  /** A consent: seals the Convex connector token it maps to, purpose `mcp:<grantId>` (was mcp_grants). */
  mcpOAuthGrants: defineTable({
    grantId: v.string(),
    clientId: v.string(),
    sealed: v.string(),
    /** SHA-256 of the connector token (as connectorGrants.tokenHash), so revoking needs no unsealing. */
    connectorTokenHash: v.string(),
    scope: v.string(),
    resource: v.string(),
    expiresAt: v.number(),
    revoked: v.boolean(),
  }).index("by_grantId", ["grantId"])
    .index("by_clientId", ["clientId"])
    .index("by_revoked_and_expiresAt", ["revoked", "expiresAt"]),

  /** Authorization codes, SHA-256 hashed; used codes stay as tombstones until they expire (was mcp_codes). */
  mcpOAuthCodes: defineTable({
    codeHash: v.string(),
    grantId: v.string(),
    redirect: v.string(),
    challenge: v.string(),
    expiresAt: v.number(),
    used: v.boolean(),
  }).index("by_codeHash", ["codeHash"])
    .index("by_grantId", ["grantId"])
    .index("by_expiresAt", ["expiresAt"]),

  /** Access and refresh tokens, SHA-256 hashed (was mcp_tokens). */
  mcpOAuthTokens: defineTable({
    tokenHash: v.string(),
    grantId: v.string(),
    kind: v.union(v.literal("access"), v.literal("refresh")),
    expiresAt: v.number(),
    used: v.boolean(),
    scope: v.optional(v.string()),
  }).index("by_tokenHash", ["tokenHash"])
    .index("by_grantId", ["grantId"])
    .index("by_expiresAt", ["expiresAt"]),

  /** Claimed-before-send invitation emails, so an ambiguous SMTP failure never sends twice (was agent_invite_deliveries). */
  inviteDeliveries: defineTable({ deliveryId: v.string(), sent: v.boolean(), createdAt: v.number() })
    .index("by_deliveryId", ["deliveryId"]),

  /** One-time data migrations that already ran (was the migrations table in origin.sqlite). */
  localStoreMarkers: defineTable({ name: v.string(), createdAt: v.number() })
    .index("by_name", ["name"]),

  /**
   * Rows from the retired local store that no current code reads but that must not be lost: execution.sqlite (coding
   * runner hosts, accounts, settings, runs, events, audit) and integrations.sqlite's instance_operator. `payload` is the
   * row as JSON; every secret inside it was re-sealed with ORIGIN_SEALING_KEY under its original purpose by the migration.
   */
  localStoreArchive: defineTable({
    source: v.string(),
    key: v.string(),
    teamId: v.optional(v.string()),
    payload: v.string(),
    importedAt: v.number(),
  }).index("by_source_and_key", ["source", "key"])
    .index("by_teamId_and_source", ["teamId", "source"]),
};

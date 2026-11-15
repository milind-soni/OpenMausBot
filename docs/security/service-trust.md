# Security Architecture Proposal: Service-Trust Loopback Model & Cross-Bot Isolation

## 1. Executive Summary

In OpenMausBot, local loopback requests (`127.0.0.1`, `::1`, `localhost`) without a user session are evaluated under one of two trust tiers defined in `server/request-auth.ts`:
- **`owner` trust**: Granted in single-user packaged desktop installations, where local loopback access carries full `["admin", "client"]` scopes.
- **`service` trust**: Configured on shared servers, hosted workspaces, and MausBot Cloud homes (`OMB_LOOPBACK_TRUST=service`). On these systems, session-less loopback callers are restricted to routes matched by the `SERVICE_ALLOW` whitelist (`client` scope only).

While `SERVICE_ALLOW` successfully blocks administrative mutations (such as creating bots, altering settings, or modifying webhooks), it currently permits unauthenticated loopback reads to:
- `GET /api/bots` (lists all bots and metadata)
- `GET /api/threads/:id/messages` (reads conversation messages of any known thread ID)
- `GET /api/attachments/:name` (downloads attachments by filename)
- `POST /api/bots/:id/tasks` & `POST /api/bots/:id/messages/guarded` (interaction entry points)

Because local bot processes, tool scripts, subagents, and third-party plugins run in network namespaces that share loopback access to the server, any executing bot shell can query `GET /api/bots` to discover sibling bots, read messages from arbitrary threads across other bots, or download attachments across workspaces.

---

## 2. Threat Model Analysis

### 2.1 Single-User Local Desktop (Low Risk)
- **Deployment**: Electron desktop app on macOS/Windows/Linux running for a single human operator.
- **Trust Assumption**: Full trust across processes. The user owns all bots, tools, and workspaces.
- **Impact**: Cross-bot access represents an architectural layering detail rather than a privilege boundary breach, as the local operating system user already has read/write permissions over all workspace directories.

### 2.2 Team & Multi-Tenant Cloud Deployment (High Risk)
- **Deployment**: Hosted Linux servers, containerized workspaces, MausBot Cloud homes, or shared VPS instances running multiple bots serving multiple team members.
- **Trust Assumption**: Semi-trusted execution. Bots execute external plugins, tools, code interpreters, MCP servers, and LLM-driven actions.
- **Impact**:
  1. **Confidentiality Loss**: A compromised or untrusted bot process can inspect `GET /api/bots` to enumerate all bots on the instance, extract thread IDs, and exfiltrate transcripts and attachments belonging to other bots or users.
  2. **Integrity / Interaction Risk**: As noted in source comments (`server/request-auth.ts`), any loopback process can post into guarded routes or interrupt tasks belonging to sibling bots.

---

## 3. Remediation Architecture Options

### Option A: Capability-Scoped Bot Tokens (Recommended)
**Concept**: Generate a cryptographically random, ephemeral capability token per bot execution turn. Pass this token via environment variables (`OMB_BOT_TOKEN`) or standard `Authorization: Bearer <token>` headers to spawned processes.

- **Mechanism**:
  - The server mints a token with claims `{ botId: string, turnId: string, allowedThreads: string[] }` and a short TTL bound to the turn lifecycle.
  - Loopback routes in `SERVICE_ALLOW` require this bearer token when `trust === "service"`.
  - The route handler validates that `req.auth.botId === targetBotId`. Cross-bot requests without explicit authorization receive `403 Forbidden`.
- **Pros**:
  - Granular least-privilege enforcement.
  - Zero filesystem socket dependencies; works uniformly across Linux, Windows, and container platforms.
  - Integrates naturally with standard HTTP / MCP client libraries.
- **Cons**:
  - Requires passing the token down the process tree to CLI tools and drivers.

### Option B: Unix Domain Sockets with OS File Permissions
**Concept**: Discontinue binding internal service APIs on generic TCP loopback (`127.0.0.1:8799`). Instead, expose service routes via Unix Domain Sockets (UDS) with strict filesystem permission masks (`0700` / `0770`) or per-bot socket paths (`/run/openmausbot/bots/<bot-id>.sock`).

- **Mechanism**:
  - Each bot container or process runs under a dedicated OS user/group UID or receives a mounted socket specific to its bot ID.
  - Peer credentials (`SO_PEERCRED` on Linux, `getpeereid` on BSD/macOS) identify the calling process UID without application-level tokens.
- **Pros**:
  - Impossible for an unprivileged process to spoof identity.
  - Kernel-enforced access control.
- **Cons**:
  - Limited Windows compatibility (Windows named pipes or AF_UNIX support has platform-specific edge cases).
  - High operational complexity in containerized or shared process environments.

### Option C: Context-Bound Route Dispatch (Own-Bot Filtering)
**Concept**: Retain TCP loopback but enforce default-deny on cross-bot resources. Every endpoint under `SERVICE_ALLOW` that references a `:botId` or `:threadId` must verify that the requesting context owns or matches that identifier.

- **Mechanism**:
  - `GET /api/bots` under service trust returns only the bot belonging to the caller's execution context (or empty list if no context header is supplied).
  - `GET /api/threads/:id/messages` verifies the thread belongs to the authorized bot.
  - `GET /api/attachments/:name` requires proof of attachment ownership or active turn access.
- **Pros**:
  - Minimal changes to existing tooling; transparent fallback.
- **Cons**:
  - Still requires a reliable mechanism (such as Option A's token or process PID lookup) to distinguish *which* bot made the loopback call.

---

## 4. Proposed Migration Strategy & Roadmap

1. **Phase 1 (Compatibility & Observation — Current State)**:
   - Document trust assumptions and keep characterization tests pinning `SERVICE_ALLOW`.
   - Maintain current single-user default behavior.

2. **Phase 2 (Opt-in Strict Mode)**:
   - Introduce `OMB_STRICT_SERVICE_AUTH=true` flag.
   - When enabled, mint ephemeral `OMB_BOT_TOKEN` in runner environments (`server/bot-box/` and `server/drivers/`).
   - Restrict `GET /api/bots` and `GET /api/threads/:id/*` to requests carrying a valid matching token.

3. **Phase 3 (Default On for Shared / Cloud Roles)**:
   - Turn strict mode ON by default when `OMB_CLOUD_ROLE === "home"` or `OMB_CLOUD_ROLE === "team"`.
   - Legacy unauthenticated loopback access deprecated with structured security warning logs.

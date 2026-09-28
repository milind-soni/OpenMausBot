# Connect apps through Composio

OpenMausBot uses one Composio project API key and one reusable Composio Session. That project key is the only Composio credential users need to provide. The Session enables Composio's multi-account mode with explicit account selection, so one OpenMausBot installation can keep several Slack, Gmail, Calendar, or other accounts connected without silently replacing the first one.

## Packaged desktop app

1. Open the [Composio Dashboard](https://dashboard.composio.dev).
2. Select **Platform**, select or create a project, then open **Settings → API Keys**.
3. Copy a project key beginning with `ak_`.
4. In OpenMausBot, open **App Settings → Connections** and save it under **Composio project key**.
5. Open **Connected apps** and choose Gmail, GitHub, Slack, or another service. Enter a unique label such as `work` or `personal`, then finish the authorization in your normal browser.
6. To connect another account for the same app, choose **Add account**, give it a unique label, and finish the second authorization in your browser.

The Connected tab lists every account separately. **Disconnect** revokes only the account named on that row. OpenMausBot asks for a label for every new account and configures Composio to require explicit selection when more than one account could run a tool; a new OAuth flow never silently becomes the default for an existing connection.

The desktop app validates the key before saving it. The key is encrypted using Electron's operating-system-backed `safeStorage`; the local JSON configuration stores only the non-secret Composio user and Session identifiers.

## Scoped key permissions

A default project API key works without additional configuration. For a least-privilege scoped key, grant:

- **Sessions:** read and write
- **Toolkits:** read
- **Connected accounts:** read and write

Connected-account write access is required so **Disconnect** can revoke the upstream provider grant before removing the connection.

## Running from source

Set the key in the server environment:

```sh
COMPOSIO_API_KEY=ak_your_project_key pnpm dev:server
```

The browser-only development UI can also save a key to the owner-only `~/.openmausbot/config.json` file. Using the environment variable is preferred for headless and shared development machines.

OpenMausBot creates a stable random user identifier for the installation, stores the returned Session identifier, and reuses that Session across launches. No Gmail, GitHub, Slack, or other provider tokens are stored by OpenMausBot; Composio owns their connection lifecycle.

Sessions created by older OpenMausBot versions are upgraded in place by creating a multi-account Session for the same stable Composio user. Connected accounts belong to that user, so existing grants remain available while the new Session adds explicit multi-account routing. Each toolkit is capped at five usable accounts.

## Multiple Google and Slack accounts

Yes. Gmail, Google Calendar, Google Drive, and the other Google toolkits can each hold multiple labeled authorizations, and Slack can hold multiple labeled workspace/account authorizations. Accounts are scoped to the OpenMausBot installation's stable Composio user and appear by alias and connected-account ID in **Connected apps**.

If a provider or restricted Composio project policy prevents another authorization, the safe fallback is a separate OpenMausBot installation/configuration with its own Composio user. Re-authorizing the same single-account Session is not a safe workaround: it can change which grant is selected. Do not share raw provider tokens or place them in bot prompts.

The hosted/managed connected-apps broker exposes the same account-aware response shape and account-specific removal routes as the self-hosted project-key mode; it does not send broker or provider credentials to the renderer.

## Renderer-neutral connection inventory

Desktop, web, and mobile clients can load the complete account inventory in one request:

```http
GET /api/connectors/connected
```

```json
{
  "configured": true,
  "services": {
    "gmail": {
      "connected": true,
      "pending": false,
      "status": "ACTIVE",
      "accounts": [
        { "id": "ca_123", "alias": "work", "status": "ACTIVE" }
      ]
    }
  }
}
```

This operation cursor-paginates both the Session toolkit state and the user's connected accounts directly. It merges no-auth toolkits and the Session-selected account with the full multi-account inventory, without deriving service slugs from marketplace cards, so account visibility is independent of catalog ordering and pagination. If a scoped project key can read the Session but cannot list raw connected accounts, the response safely falls back to the Session-selected and no-auth toolkit inventory rather than making those services appear disconnected. The managed broker provides the same behavior and response at `GET /v1/connectors/connected`; the local server adds the normal `configured: false` empty response when no connection service is configured. Responses expose only connected-account IDs, user-supplied aliases, and lifecycle status—never project keys, broker tokens, provider tokens, or write-only authorization fields.

The existing scoped `GET /api/connectors?services=gmail,slack` operation remains available for lightweight post-OAuth polling and backward compatibility.

## Per-bot tool grants

The workspace-level connections above say which accounts exist. A second, per-bot layer says which of an app's **tools** each bot may actually call. Open a bot's settings on the desktop, and under **Connected apps** each service can be set to:

- **All tools** — every tool the service offers (the wildcard grant).
- **An exact list** — only the named tools, such as GMAIL_SEND_EMAIL, shown as the granted count.
- **No tools** — the service is listed but grants nothing.

A bot with no grant record at all keeps the legacy behavior: every tool on every connected app it can see. Assigning the first grant switches the bot to exact-tool mode — a service not on the list grants nothing, even when the workspace is connected to it.

**Nothing changes until you assign.** Upgrading OpenMausBot does not alter any bot's access: existing bots keep the all-tools default until someone edits their grants. An emptied grant list is deliberate and means "no tools on any connected app."

**Imported bots land with no grants.** Shareable packages and team imports never carry grants — an imported bot starts with connected apps off, and any grants it later gets are chosen by the importing workspace. Grants also never appear in exports; only the workspace's own private team backup keeps them.

Grants are enforced on the real tool names at call time (including batches inside the MULTI_EXECUTE meta-tool), the tool list offered to the model is filtered to the granted set, and every allow/deny writes a decision-log row. Refusals do not enumerate what else is granted. Paired phones see each bot's grants read-only in its profile (What this bot does → App tools); grants are assigned on the computer, never from a phone.

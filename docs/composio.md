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

## MausBot Cloud

A MausBot Cloud plan includes connected apps: there is no key to add. At every start a Cloud home's server makes sure it has its own installation on OpenMausBot's managed connection service, the same one the packaged desktop app registers with (`server/cloud-connected-apps.ts`, sharing `electron/managed-composio.mjs` with the app):

- The first start registers the installation (`POST /v1/installations`) and keeps its token in `connected-apps-installation.json` in the data folder (`/data/.openmausbot`), owner-only (0600). The token is never written to `config.json`, sent to a client or logged.
- Every later start serves that token at once and checks it with `GET /v1/me`. Only a refusal (401) registers a new installation; an outage or a rate limit keeps the token, so the Cloud's connected accounts are never stranded.
- While the Cloud has no token (the service is down or refuses new registrations), the server keeps booting and serving, Connected apps says the service is temporarily unavailable, and it tries again after 30 seconds, then 1, 2, 5, 10 and every 30 minutes, with some jitter.
- The file never goes into a backup or a move to another computer, and a restore keeps the Cloud's own (`server/workspace-backup-policy.ts`): its connected accounts belong to that installation.
- A Composio project key the owner saves under **Self-host connected apps** still wins; clearing it returns to the included service.

The built image uses the default service; `OMB_COMPOSIO_BROKER_URL` names another (a staging service, or a closed port in CI). The server run from source registers only with an explicitly named service, so development and tests never create installations on the real one.

## App events

An app-event automation runs a bot when something happens in a connected app: a new Gmail message, a Slack
message in a channel, a HubSpot deal changing stage. It uses Composio triggers through the managed service, on
the desktop, a headless server and a Cloud alike:

1. `create_trigger` (`when: "app_event"`) or the editor saves the automation in `app-triggers.json` in the data
   folder and creates its trigger on the service (`POST /v1/triggers`), which checks that the connected account
   belongs to this installation. A Gmail filter (from, subject, label, words) becomes Gmail's own search, so
   other mail never arrives; other apps match the filter as events arrive.
2. Composio posts each event, signed, to the service, which queues it per installation for up to 7 days.
3. The server long-polls the queue (`GET /v1/events`, 25 seconds at a time) while it has an automation switched
   on. Each event becomes a routine run, with the event fenced as untrusted data. A burst shares runs: at most 3
   waiting runs per automation, up to 20 events each. The cursor that acknowledges events moves only after the
   run is saved, and a redelivered event is recognised by its id, so each event runs once.
4. The server compares its automations with the service at start and every 15 minutes (hourly while all are
   paused) and fixes any difference by itself: a lost copy is made again, an unwanted one is removed, on/off is
   matched. An expired connection shows as **Needs you** with **Reconnect**.

| | Desktop | Paid Cloud |
| --- | --- | --- |
| Events kept per day (UTC) | 500 | 2,000 |

A Cloud counts as paid once its server presents the Admin's signed grant (`OMB_CLOUD_CONNECTED_APPS_GRANT`).
Events over the limit are not run; the automation shows how many were skipped today and why.

Gmail and other polled apps are checked every 15 minutes, the minimum for Composio-managed sign-ins. A server
that uses its own Composio project key cannot watch apps yet: `list_trigger_events` and the editor say so, and a
schedule that checks the app, or a webhook, does the job instead.

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

## Permissions the default connection does not ask for

Each app you connect uses the Composio project's authorization for that app. Unless you set up your own, that is the Composio-managed one, which asks the provider only for Composio's default permissions. Some actions need more. In Gmail:

- **Filters, the vacation responder, IMAP and POP settings** need `https://www.googleapis.com/auth/gmail.settings.basic`.
- **Forwarding addresses, send-as aliases and delegates** need `https://www.googleapis.com/auth/gmail.settings.sharing`.

Without the permission, Google refuses the call with `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`. Reconnecting the account does not help: the consent screen asks for the same permissions every time. OpenMausBot adds a note to that refusal, so the bot tells you what to change instead of retrying.

To grant the permission:

1. In the [Composio Dashboard](https://dashboard.composio.dev), open your project's **Auth Configs** and create an auth config for the app (for example Gmail) that uses your own OAuth app credentials.
2. Add the permissions you need to it, keep it enabled, and leave it available to Tool Router.
3. In OpenMausBot, open **Connected apps** and reconnect the account. The consent screen now asks for the added permissions.

OpenMausBot uses your project's own auth config for an app automatically, in place of the Composio-managed one. If there are several for the same app, it uses the most recently updated, and it skips disabled ones and ones turned off for Tool Router. Google may require your OAuth app to list the added permissions on its consent screen, and to be verified before people outside your organization can grant them.

On a MausBot Cloud plan, connected apps run through OpenMausBot's managed connection service rather than your own Composio project, so you cannot add permissions yourself; ask OpenMausBot support instead.

## Apps with no Composio-managed sign-in

Some apps, such as Xero and Buffer, have no sign-in that Composio provides: they connect only through an auth config holding your own OAuth app. Without one, Composio answers "Composio does not manage auth for toolkit … and no auth config without required fields is available".

With your own Composio project key, create the auth config in the Composio dashboard (**Auth Configs → Create**), keep it enabled and available to Tool Router, then connect the app. OpenMausBot reads the project's enabled auth configs (at most once a minute, and again right after Composio reports a missing one) and names them in the Session, so the app connects with no further input. A Session that predates a new auth config is replaced once, under the same Composio user, so existing connections stay. If the auth configs cannot be read, the Session keeps the ones it last read; if Composio refuses the Session with them, it is created without them, and connecting that app says why.

A bot can also name one auth config for an app: `COMPOSIO_MANAGE_CONNECTIONS` with `toolkits: [{ "name": "xero", "action": "add", "auth_config_id": "ac_…" }]` (`auth_config_override` is read as well). OpenMausBot checks the id in your project before it shows the Connect card (it must exist, belong to that app, be enabled and be available to Tool Router) and keeps the choice in `composio-auth-configs.json` in the data folder, so later Sessions use it while it stays usable.

OpenMausBot's managed connection service (the desktop default and MausBot Cloud) runs on OpenMausBot's own Composio project, which cannot use an auth config in yours. For such an app it says so in one line: add your own Composio project key in **Settings → API keys**, with an enabled auth config for that app in that project.

## Browser authorization recovery

The web UI reserves an authorization tab during your click, before requesting
the link. If the browser still blocks it, use **Open authorization page** in
the Apps modal or connector card. **Continue** / **Open again** reuses the
pending link instead of creating another account. Links stay in UI memory only;
after ten minutes, retry requests a fresh link, as required by
[Composio's connection lifecycle](https://docs.composio.dev/kb/guide/platform-connected-accounts).

A label is required only when the app already has an `ACTIVE` account (or one
whose status Composio did not report). While no account works, an alias-less
retry gets a unique `omb-retry-…` alias and leaves the other accounts alone.
Asking again for a label held only by an account that is not active (for
example an `INITIATED` sign-in that was abandoned, or a `FAILED` or `EXPIRED`
one) revokes and deletes that account, then links a new one under the same
label; a label an active account holds is still refused with 409. The
five-usable-account limit remains; the account being replaced does not count
toward it. Managed installations need the updated broker as well as the
updated app; this is not a client-side bypass.

In **Connected apps**, only an `ACTIVE` account shows the app as connected. An
app whose accounts all stopped working shows **Reconnect**, which removes the
newest stopped account and signs in again under its label; each stopped account
beside a working one has its own **Reconnect**. When a connected-app call fails
because the account is signed out (Composio's `USER_NOT_LOGGED_IN`, a 401, or no
connected account), OpenMausBot adds a note telling the bot to call
`COMPOSIO_MANAGE_CONNECTIONS`, which shows the person a reconnect card. That
tool stays available to a bot with no app grants, and a failed `tools/list` is
retried once and then answered with the last list the connection service gave.

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

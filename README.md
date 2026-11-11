# Origin

A self-hosted team workspace: projects with an issue board, inbox, chat, calls, a shared Draw canvas and GitHub sync. Built with Next.js and Convex.

## Run locally

Requires Node.js 24.

```sh
npm ci
npx convex dev            # local Convex backend; writes .env.local
```

In a second terminal:

```sh
SECRET=$(openssl rand -hex 32)
npx convex env set ORIGIN_INTEGRATION_SECRET "$SECRET"
npx convex env set ORIGIN_SEALING_KEY "$(openssl rand -base64 32)"
npx convex env set ORIGIN_PUBLIC_URL http://localhost:3000
ORIGIN_INTEGRATION_SECRET="$SECRET" ORIGIN_PUBLIC_URL=http://localhost:3000 npm run dev
```

`ORIGIN_PUBLIC_URL` in the Convex env lets its 2-minute tick reach the app; without it repository creation, GitHub sync, chat-mention retries and MCP consent cleanup never run.

Open http://localhost:3000 and create an account.

Checks: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run e2e`.

## Deploy

1. Deploy the backend to your Convex production deployment and set its environment:

   ```sh
   npx convex deploy
   npx convex env set ORIGIN_INTEGRATION_SECRET <openssl rand -hex 32>
   npx convex env set ORIGIN_SEALING_KEY "$(openssl rand -base64 32)"
   npx convex env set ORIGIN_PUBLIC_URL https://origin.example.com
   npx convex env set ORIGIN_SIGNUP_MODE invite   # optional, after creating your account
   ```

   `ORIGIN_SEALING_KEY` encrypts stored GitHub and MCP credentials; keep it stable.

2. Copy `.env.example` to `.env`, fill in the Convex URLs, `ORIGIN_PUBLIC_URL` and the same `ORIGIN_INTEGRATION_SECRET`, then:

   ```sh
   docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
   ```

   The app listens on `127.0.0.1:3000`; put an HTTPS reverse proxy in front that overwrites `X-Real-IP` and set `ORIGIN_TRUSTED_PROXY=1`. The web app is stateless (everything lives in Convex), so it needs no volume and can run as several replicas or on Vercel (`vercel.json`). Deploy the Convex backend before a new web build. Details, Vercel, email, TURN and the pre-deploy checklist: [deploy/README.md](deploy/README.md).

## Connect AI agents (MCP)

Origin is a remote MCP server at `https://<your-origin>/api/mcp` (Streamable HTTP). Agents act as you, with your workspace and project permissions. Settings → Agents has the URL, per-client setup and access tokens.

Sign in with OAuth (each opens Origin's consent page):

```sh
claude mcp add --transport http origin https://<your-origin>/api/mcp           # Claude Code, then /mcp
codex mcp add origin --url https://<your-origin>/api/mcp && codex mcp login origin
opencode mcp auth origin    # OpenCode, with origin as a "remote" server in opencode.json
```

omp reads `~/.omp/agent/mcp.json` (`{"mcpServers": {"origin": {"type": "http", "url": "..."}}}`); sign in with `/mcp reauth origin`.

Or create an access token in Settings → Agents and send it as a header:

```sh
claude mcp add --transport http origin https://<your-origin>/api/mcp --header "Authorization: Bearer origin_pat_..."
```

- **Tested with:** Claude Code 2.1 (token), Codex 0.166, OpenCode 1.19 and omp 18.14 (token and OAuth). ChatGPT developer mode uses OAuth and needs a public HTTPS address.
- **Tools:** `get_workspace`, `list_projects`, `list_issues`, `get_issue`, `get_inbox`, `list_members`, `list_assets`, `get_asset`, `vault_list`, `vault_get`, `list_repos`, `list_pull_requests`, `list_agents`, `list_issue_activity`, and with write access `create_issue`, `update_issue`, `move_issue`, `add_comment`, `add_acceptance_criteria`, `update_acceptance_criteria`, `delegate_issue`, `add_agent_activity`. Settings → Agents lists the same set (`lib/mcp-tools.ts`).
- **Issues and specs:** issues carry `acceptanceCriteria` (`[{ text, checked }]`), shown as a checklist under the description. A bare note created in Draft gets the **Needs spec** label; it comes off once the issue has a description and at least one criterion.
- **Vault:** `vault_list` and `vault_get` only reach items a member allowed agents to use. The Vault is end-to-end encrypted, so `vault_get` needs the Vault passphrase; it is used for that call only. Without it, or with a wrong one, the call fails and returns no value.

Revoke connections and tokens in Settings → Agents.

## Issue webhooks

Origin can POST an event when an issue is created (`issue.created`) and when its status or completion changes (`issue.updated`; title and description edits send nothing). Set a URL and signing secret per workspace in Settings → Workspace, or a deployment-wide default in the Convex env (the workspace's own wins):

```sh
npx convex env set ORIGIN_ISSUE_WEBHOOK_URL https://hooks.example.com/origin
npx convex env set ORIGIN_ISSUE_WEBHOOK_SECRET "$(openssl rand -hex 32)"   # at least 32 characters
```

Each request has `Content-Type: application/json`, `X-Origin-Event`, `X-Origin-Delivery` (the event id) and `X-Origin-Signature: sha256=<hex>`, the HMAC-SHA256 of the raw body under the secret. Issue URLs in the body are absolute when `ORIGIN_PUBLIC_URL` is set in the Convex env. A delivery times out after 10 seconds and is retried twice; it never blocks the issue change. Body (see `lib/issue-webhook.ts`):

```json
{
  "id": "evt_…", "type": "issue.updated", "occurredAt": "2026-11-11T09:00:00.000Z",
  "workspace": { "id": "…", "name": "Acme", "slug": "acme" },
  "project": { "id": "…", "name": "Web", "repo": "acme/web" },
  "issue": { "id": "…", "key": "ORI-AB12", "title": "…", "description": "", "labels": ["Needs spec"], "url": "https://origin.example.com/acme/issue/ORI-AB12",
    "status": "Todo", "completed": false, "assignee": null, "acceptanceCriteria": [] },
  "changes": { "status": { "from": "Draft", "to": "Todo" } }
}
```

`changes` is `null` for `issue.created`; for `issue.updated` it has `status` and/or `completed`, each `{ from, to }`. To try a receiver without a workspace:

```sh
ORIGIN_ISSUE_WEBHOOK_SECRET='…' node scripts/origin-webhook-test.mjs --url http://127.0.0.1:8787/hook [--event issue.updated]
```

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

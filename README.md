# Origin

A self-hosted team workspace: projects with an issue board, inbox, chat, calls, a shared Draw canvas, GitHub sync and supervised coding runners. Built with Next.js and Convex.

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

   `ORIGIN_SEALING_KEY` encrypts stored GitHub credentials; keep it stable.

2. Copy `.env.example` to `.env`, fill in the Convex URLs, `ORIGIN_PUBLIC_URL` and the same `ORIGIN_INTEGRATION_SECRET`, then:

   ```sh
   docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
   ```

   The app listens on `127.0.0.1:3000`; put an HTTPS reverse proxy in front that overwrites `X-Real-IP`, set `ORIGIN_TRUSTED_PROXY=1`, and persist the `origin-data` volume. Deploy the Convex backend before a new web image. Details, email, TURN and the pre-deploy checklist: [deploy/README.md](deploy/README.md).

### Coding machines and subscription usage

Settings → Machines enrolls a Node.js service on each approved machine. Origin starts the chosen native CLI in a separate Git worktree; it does not open a desktop terminal. Follow output and approvals in Origin, or inspect the local service journal. Existing interactive CLI installations and personal checkouts remain separate.

Settings → Accounts & usage shows native account identity, subscription windows, reset times and freshness. Execution settings select account, harness, model, effort and fallback priority per workspace, project or task. NixOS is preferred; Mac is Apple-only unless explicitly selected. Boxd or Boat may be used only when eligible local machines are independently confirmed offline, not merely busy or paused. Cloud provider switching is explicit.

Verification and a runnable smoke check gate merging the exact task SHA into `main`; deployment is a separate receipt. Scoped automation environments do not replace the personal passphrase vault. Enrollment, update and cloud safety details: [supervised execution](deploy/README.md#8-supervised-coding-execution).

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
- **Tools:** `get_workspace`, `list_projects`, `list_issues`, `get_issue`, `get_inbox`, `list_members`; with write access, `create_issue`, `update_issue`, `move_issue`, `delete_issue`, `add_comment`.
- **Execution tools:** `list_execution_hosts`, `get_execution_usage`, `list_execution_runs`, `get_execution_run`; with write access, `start_execution_run`, `cancel_execution_run`, `message_execution_run`, `set_execution_policy`. Policy changes cannot grant cloud spending, paid API access, or weaker verification and merge gates.

Revoke connections and tokens in Settings → Agents.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

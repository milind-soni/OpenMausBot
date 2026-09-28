# Exact command allowlist

Open **Command allowlist** from the composer's approval menu (after Full access)
or a bot's Permissions settings. Save a complete command and working folder,
or choose **Always allow this command** on an eligible native approval card.
Rules belong to that bot and provider instance across threads using the same
folder. They are not a filesystem sandbox, command prefixes or wildcard rules.
Full access is unchanged. Other commands keep the selected provider mode.

Claude Bash, Codex native shell approvals, and ACP execute requests can provide
the required structured input. If a provider omits a complete command or folder,
its existing approval UI remains. Questions, arbitrary MCP/computer operations
and requests to widen a provider sandbox cannot acquire a command rule. Only
owners/admins manage bot-wide rules. Rules stay on this installation; templates,
copies and workspace backups do not carry them to another bot or machine.

Use the disposable server and browser from `control-omb ui`; this recipe never
opens the user's desktop app or writes to the user's workspace data.

## Launch and drive

```sh
node --experimental-strip-types scripts/control-omb.ts ui launch
```

Keep the launcher running. In a second terminal, pass the exact `ui.json` path
it printed to the asserted recipe:

```sh
node --experimental-strip-types scripts/verify-command-allowlist-ui.ts /tmp/openmausbot-verify-data-XXXXXX/ui.json
```

The script uses the real app, accessible control names and the fixture's HTTP
API. Start from a fresh launch with no saved rules. It proves:

- The composer's approval menu opens **Command allowlist**, whose working
  folder defaults to the server's current thread context.
- The dialog initially focuses Close, wraps Shift+Tab/Tab, closes on Escape
  and returns focus to the approval button.
- Adding `git status --short` saves the exact command, current provider and
  working folder. Closing and reopening still shows the saved rule.
- Removing that rule clears it from the real API and displays the empty state.
- The bot's **Permissions → Manage command allowlist** opens the same view.
  Escape closes this nested dialog while keeping bot settings open and returns
  focus to its management link.
- An unsupported-provider response hides the add form, and a failed load
  exposes Retry. The subsequent successful retry reads from the real server.

The last two error/unavailable responses are narrow browser substitutions for
one allowlist GET each. All add/remove writes and persistence checks reach the
real isolated server. They verify the renderer's states, not provider support
detection.

The ordinary browser preview intentionally lacks the packaged desktop bridge,
so it hides Full access. These focused tests verify that, when available, the
new menu action follows Full access, does not change its selection callback,
and that eligible cards send one atomic remember-and-allow action. They also
cover owner/admin gating and the existing once/session/peer choices:

```sh
pnpm exec vitest run src/components/ApprovalModeSelector.allowlist.test.ts src/components/PendingApproval.command-allowlist.test.ts src/components/ApprovalModeSelector.test.ts
```

## Evidence and cleanup

The recipe prints its passing checks, asserts an error-free renderer console,
and prints the exact live handle and persistent server log path. Screenshots are kept under
`.omb-scratch/verify-evidence/command-allowlist/`: `saved-command.png`,
`unsupported-provider.png` and `settings-allowlist.png`. The fixture stays open
with the settings allowlist visible for inspection.

When finished, interrupt the original launcher with Ctrl-C. It closes its own
browser and preview, stops its server and removes only its disposable home.
The printed server log and screenshots remain.

## Server and provider verification

```sh
pnpm exec vitest run server/command-allowlist.e2e.test.ts server/command-allowlist.test.ts server/auto-approve.test.ts server/workspace-backup-policy.test.ts
pnpm exec vitest run server/drivers/claude.test.ts server/drivers/codex.test.ts server/drivers/acp/acp.test.ts
```

The first test launches the real server in an isolated home, sends prompts to
its fake Claude CLI and raises requests through its actual native permission
socket. It asserts remembered/repeated/revoked commands, exact-match negatives,
folder isolation, owner/member permissions, stale cards, restart persistence
and decision receipts. Provider tests cover complete command transport,
questions/MCP exclusion and actual allow/deny outcomes (including ACP requests
with no allow option). Storage tests exercise bot/provider scope, disk failures
and malformed files. Backup policy tests exclude these installation-local rules.

These checks do not prove live-account model behavior or the Electron privileged
Full access bridge. See [Full Access verification](full-access.md) for its
independent regression coverage.

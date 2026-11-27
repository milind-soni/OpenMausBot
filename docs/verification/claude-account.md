# Claude account sign-out

Use only the disposable offline fixture. It never invokes a real Claude
executable or reads a real credential store.

```sh
node --experimental-strip-types scripts/verify-claude-account.ts
```

The launcher prints its API URL, preview URL, command log, disposable home,
and `failLogoutMarker`. Run Doctor against that exact API URL, then open the
preview. In Settings → Engines, the synthetic **Claude review** account is
connected as `ada@example.test`.

1. Open the account's **⋯** menu → **Sign out**. Cancel once and confirm the
   identity remains. The confirmation says running tasks are not cancelled.
2. Confirm sign-out. The fake CLI deliberately fails, leaving the account
   connected. An error must appear below the **⋯** button, and the menu must
   allow a retry.
3. Remove only the printed `failLogoutMarker` inside this disposable home.
   Retry. While pending, the **⋯** button shows a spinner and is disabled.
   When complete, the email disappears, the row reads **Not signed in**, and
   it offers one **Sign in** button.
4. Reload the preview and check the account remains signed out. The command
   log must show `auth logout` followed by `auth status --json`.
5. Close the preview and interrupt the launcher. It removes only its own
   temporary data and retains the printed server log.

The HTTP verification also checks cross-origin rejection, failed sign-out
preserving the synthetic account, successful retry, and an untouched sibling
account. Unit regressions cover a logout that ignores SIGTERM, disposal of
the controller/provider during logout, unknown auth-status results, and the
renderer using the confirmed response without a second catalog request.

```sh
pnpm exec vitest run --no-file-parallelism server/drivers/claude-login-auth.test.ts server/drivers/claude.test.ts server/provider-auth-sessions.test.ts server/request-auth.test.ts src/components/EnginesSettings.test.ts src/components/ClaudeSignIn.interaction.test.ts
pnpm typecheck
pnpm i18n:check
pnpm build
```

## UI evidence

Confirmation after a forced error; the real Settings surface remains retryable:

![Claude sign-out confirmation](evidence/claude-account/confirmation.png)

This offline check does not prove a real Anthropic account login or OS
credential-store operation. No provider login was used for this review.

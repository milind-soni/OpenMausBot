# Isolated member coding

NATION's API agent can call `computer_code_start` and `computer_code_status`
when its assigned computer is Daytona and coding is explicitly enabled.
Codex runs inside that computer, using a persistent named project at
`~/.nation-coding/<project>`. Each account keeps the existing private workspace
and provider machine ownership boundary. Native engines on the shared NATION
host remain unavailable to members. Orgo keeps its existing computer tools.

The server fixes the model, bills each inference to the conversation's credit
sponsor, and gives the remote job only a short-lived capability. That capability
cannot access member/admin routes or another workspace, and expires when the
turn ends, is stopped, loses its computer lease, or the server restarts. The
public proxy forwards only to an already-running workspace; it never creates
a session. Main model and infrastructure credentials stay on the backend.

Each job is limited to ten minutes and 32 sequential model requests, each with
at most 8,192 output tokens. Missing model cost blocks further spending through
the existing unconfirmed-call ledger. Results are buffered until cost is known.
The remote supervisor checks its lease every two seconds (five-second network
timeout), stops its process group on cancellation, and keeps project files.
An uncertain provider execution leaves a durable machine mutation fence until
the job deadline plus one minute. Existing arbitrary user processes outside
that process group are governed by the remote computer boundary.

Projects persist across tasks; this does not restore Codex's previous native
conversation. The NATION agent must supply the request and relevant context.
The CLI uses ephemeral native sessions and its workspace-write sandbox with noninteractive approval policy;
shell network access follows that sandbox policy. Configure needed project
dependencies in the snapshot or through the existing computer tools.

## Configure

1. Build `deploy/Daytona.coding.Dockerfile` with `deploy/` as its build
   context. It pins Codex CLI to 0.157.1 under `/opt/nation-codex` and sets
   `USER root` inside the private account computer. Select `user: "root"` in
   the operator's Daytona configuration too. The base desktop image's default
   user cannot create Codex's bubblewrap network namespace; changing only SDK
   user metadata does not change that image's process user. Root here is
   confined to that account's provider computer, never the shared backend.
   Run `deploy/verify-isolated-coding.sh` as the actual execution user after
   startup. It must prove project write/read, outside-write denial and shell
   network denial. Do not disable workspace-write to make an image pass.
2. Configure and test Daytona in Admin, selecting that snapshot. Existing
   machines need the runtime installed separately; changing the snapshot does
   not replace their disks or upgrade them automatically.
3. Keep `OPENROUTER_API_KEY` server-side. Set `NATION_CODING_MODEL` to the exact
   OpenRouter OpenAI model ID validated for the Responses API. Set
   `NATION_CODING_PUBLIC_ORIGIN` to the public HTTPS origin serving
   `/api/coding-model/*`. A reverse proxy must allow the opaque bearer header
   and allow a response to take up to 190 seconds. No browser cookies are used.
   Verify this origin is reachable from the guest, not just from the backend.
   Daytona Tier 1/2 organization restrictions cannot be overridden by sandbox
   allow lists. Obtain supported gateway access before proceeding; see
   [Daytona network limits](https://www.daytona.io/docs/en/network-limits/).
4. Set `NATION_CODING_ENABLED=1` for an isolated staging installation first.
   Existing workspace processes need a graceful restart to inherit changes.
   Select Cloud/Daytona for the agent and use a verified account with credit.
   Keep `NATION_MEMBER_HOST_ENGINES` disabled.

Do not set `NATION_TEST_CODING` in production; it permits loopback HTTP only
for disposable fixtures. No automatic install, live account changes, or
production activation is performed by these tests.

## Reproduce

Run from the repository with dependencies installed:

```sh
node node_modules/vitest/vitest.mjs run server/isolated-coding.test.ts server/isolated-coding-runner.test.ts server/hosted-computers.e2e.test.ts server/hosted-computers/manager.test.ts server/routes/hosted-computers.test.ts server/workspace-host.test.ts
```

The app workflow uses `launchVerificationServer`, two email accounts, separate
workspace server children, and loopback model, payment and computer providers.
Alice writes a project value; Bob cannot read it; Alice can read it in a later
turn. Their credit balances change independently, completed capabilities fail,
and tokens/provider credentials never appear in member responses. Server logs
are retained under `/tmp/openmausbot-verification-evidence/` by the launcher.

The supervisor test runs real Python plus a synthetic CLI in a disposable
home. It verifies persistent files, removal of inherited provider credentials,
token redaction, and process-group cancellation after lease revocation.
Component tests also cover stale generations, cross-account status access,
workspace routing, restart fences, pinned model selection, and missing costs.

For the optional real CLI transport smoke, install the pinned version outside
this repository and set `NATION_TEST_CODEX_BIN` to its absolute executable path
when running `server/isolated-coding.test.ts`. It uses synthetic model responses
and billing, and asks the real CLI to write one file in a disposable project.
No paid model API is called. The separate `Isolated coding runtime` workflow
runs this acceptance test on a clean Linux CI runner, including for drafts.

## Live acceptance

The current [dated verification record](isolated-coding-2026-09-27.md) separates
passing runtime checks from the remaining live acceptance. Keep the PR draft
and production coding disabled until both real-model provider acceptance and
the signed-in two-account staging workflow pass.

`scripts/verify-isolated-coding-live.ts` exercises real Daytona, Codex, the HTTPS
capability gateway, OpenRouter and an isolated local credit ledger. It creates
two disposable computers and checks actual files/tests, independent billing,
later-task persistence, cancellation and restart capability loss. This is a
provider/service acceptance, not a browser or signed-in app acceptance.

Run on an owned staging backend with Node >=24 and dependencies installed.
Supply `DAYTONA_API_KEY` and `OPENROUTER_API_KEY` through the backend environment;
never copy them into the guest or command logs. Set:

```sh
export NATION_CODING_ACCEPTANCE=1
export NATION_CODING_MODEL=openai/gpt-5.4-mini
export NATION_CODING_PUBLIC_ORIGIN=https://your-staging-gateway.example
export NATION_ACCEPTANCE_SNAPSHOT=your-prepared-snapshot
export NATION_ACCEPTANCE_PORT=18879
node --experimental-strip-types scripts/verify-isolated-coding-live.ts
```

The HTTPS proxy must forward `/api/coding-model/` to that loopback port. The
script first verifies workspace-write confinement and guest gateway reachability.
It creates its own temporary home, database and computer registry, emits the
root path and stores `evidence.json` there. The model and provider are real and
can incur charges; fixture credit balances are synthetic. It stops its computers
in `finally` but retains disks and evidence. It never modifies production account
balances or enables production coding.

After a failure before any completed model task, `NATION_ACCEPTANCE_ROOT` may
point to the emitted temporary root to reuse those exact computers. The script
requires its own prior evidence and preserves it. Use a fresh fixture after a
completed model task so file-isolation assertions start from empty projects.
Do not point it at application data or another user's computer registry.

After this passes, repeat through the signed-in staging app: two accounts,
separate sponsor balances, real edits/tests, cancellation, and workspace restart.
Verify persisted files and refused old capabilities before enabling members.

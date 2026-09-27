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
The CLI uses its workspace-write sandbox with noninteractive approval policy;
shell network access follows that sandbox policy. Configure needed project
dependencies in the snapshot or through the existing computer tools.

## Configure

1. Build a Daytona desktop snapshot with Python 3, git, Node/npm, and
   `sh deploy/install-isolated-coding.sh`. This pins Codex CLI to 0.157.1.
   Verify the image supports Codex's workspace-write sandbox. Do not weaken
   that sandbox to work around an incompatible image.
2. Configure and test Daytona in Admin, selecting that snapshot. Existing
   machines need the runtime installed separately; changing the snapshot does
   not replace their disks or upgrade them automatically.
3. Keep `OPENROUTER_API_KEY` server-side. Set `NATION_CODING_MODEL` to the exact
   OpenRouter OpenAI model ID validated for the Responses API. Set
   `NATION_CODING_PUBLIC_ORIGIN` to the public HTTPS origin serving
   `/api/coding-model/*`. A reverse proxy must allow the opaque bearer header
   and allow a response to take up to 190 seconds. No browser cookies are used.
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
No paid model API is called.

## Live acceptance still required

Local verification on 2026-09-27 passed the two-account app workflow, billing,
gateway and supervisor checks. The broader regression run had 36 passing
tests, one optional test skipped, and two failures in workspace process
cleanup. Both failures reproduce on unchanged base commit `c4bef2c`: this
execution environment reports host PIDs from `/proc` while spawned children
report namespace PIDs.

The optional real Codex 0.157.1 smoke has **not passed here**: the CLI stalled
during session initialization before sending any model request and was
cancelled after 50 seconds. A diagnostic also observed unavailable outbound
plugin-catalog requests; disabling unused plugin/app startup did not resolve
the stall. The exact remaining cause is unconfirmed. Keep this change in draft
and coding disabled until this smoke passes in the prepared staging snapshot.

On an owned staging deployment with the prepared Daytona snapshot, repeat the
two-account workflow using the real model. Ask for an edit and a test, inspect
the actual project and test output, then stop a longer task. Confirm the job
stops and its token is refused. Restart the workspace and confirm files remain
and the old token stays invalid. Confirm usage settles against only its owner.
Do this before enabling the feature for public members. Local fixtures do not
establish live Daytona sandbox support, upstream model compatibility, gateway
reachability, or coding quality.

# Isolated coding continuation — 2026-09-27

Historical Daytona investigation. The later [Orgo acceptance](isolated-coding-orgo-2026-09-27.md)
supersedes the live-model blocker below for Orgo. Daytona still requires
provider-supported gateway access.

PR [#41](https://github.com/devnord23/nation-team-chat/pull/41) remains draft.
Production coding is not enabled. No production app process, credentials or
member data was modified. The approved staging nginx route was added on the VPS.

## Verified

- Runtime commit `aba45dd7437f9fafc34cf03299c7a5f79461834e` passed the
  [Isolated coding runtime workflow](https://github.com/devnord23/nation-team-chat/actions/runs/36325474596).
  The real pinned CLI wrote the asserted file through synthetic Responses;
  supervisor and two-account app/provider/browser fixtures passed. Ubuntu's
  bubblewrap AppArmor profile fixed the original `RTM_NEWADDR` CI failure.
- Real Daytona execution passed all eight coding/gateway/supervisor tests,
  including the optional real Codex file-write test, in a disposable checkout.
  Model responses for that test were synthetic, not OpenRouter-generated code.
- Prepared snapshot `nation-coding-01571-20260927-v2` is active, based on
  `daytonaio/sandbox:0.8.0`, with Codex 0.157.1 installed outside user homes.
  Snapshot ID: `9bad50fb-d7df-42b3-aab2-59aca9564a97`.
- A newly created computer from that snapshot executed the standalone sandbox
  preflight successfully: project write/read succeeded; outside writes and
  shell network access were denied. Workspace-write remains enabled.
- Backend-only OpenRouter Responses probe for `openai/gpt-5.4-mini` returned
  HTTP 200, `response.completed`, and a reported provider cost of $0.00003.
  This proves model transport/cost reporting, not a complete coding workflow.
- Isolated Linux staging passed focused gateway, supervisor, hosted-computer
  and browser-isolation fixtures, lint, TypeScript, locale checks and the full
  production build. The browser fixture initially failed because a Windows
  archive had CRLF shebangs; it also failed on unchanged main and passed after
  LF normalization. `.gitattributes` now preserves Linux fixture shebangs.
- Docker build/boot smoke, packaged-server smoke on all three CI platforms,
  and the credit/payment contract checks also passed on `aba45dd7`. The broader
  [CI suite](https://github.com/devnord23/nation-team-chat/actions/runs/36325474651)
  still reports Vitest, desktop/UI, control-plane and mobile failures. This
  record does not claim a green repository-wide suite or release readiness.

## Remaining blocker

The public staging route at `https://server.aurk.org/api/coding-model/` forwards
only to the isolated acceptance listener on `127.0.0.1:18879`. Nginx validation
and reload succeeded; a missing bearer capability returned HTTP 403 while that
listener ran. Existing production routes remain in place.

Daytona guests cannot reach this domain: TLS is reset before any nginx request.
The provider rejects `domainAllowList: "server.aurk.org"` with HTTP 400 and
explains that organization restrictions cannot be overridden at sandbox level.
[Daytona documents this restriction for Tier 1/2](https://www.daytona.io/docs/en/network-limits/).
Obtain Daytona-supported access to the domain or a tier supporting custom
network access. No firewall workaround or tunnel was installed.

The first real-model task therefore lost its lease before model inference.
There is no passing real OpenRouter file edit, two-user paid workflow, or live
cancellation/restart/billing acceptance yet. Do not merge or activate based on
the passing synthetic fixtures alone.

## Resume inventory

- Staging checkout: `/opt/nation-coding-staging-20260927` on the existing VPS.
- Isolated fixture root: `/tmp/nation-live-coding-E4NmaY`; evidence and fixture
  credit database remain there. It has no completed model tasks and can resume
  using `NATION_ACCEPTANCE_ROOT` after network access is resolved.
- Alice computer: `8771b1d9-0033-4ebd-b38a-68b73ffbf019`.
- Bob computer: `753ad41f-79c0-4aba-9fa2-de707310042a`.
- Original acceptance computer: `6d7655b7-ee09-483b-9bb0-b01d8e18fada`.
- Earlier base-image fixture: `b57fd836-02bf-4938-8a5f-0de548ae5b44`, archived.
- Nginx backup: `/etc/nginx/sites-available/default.bak-nation-coding-20260927`.

Acceptance computers are stopped when unused and disks are retained. The
staging listener runs only during the acceptance command. Credentials stay in
the backend environment and are absent from this record and guest projects.

Once access is available, run the gateway preflight and provider acceptance,
then the two signed-in staging accounts through the app. Only after all required
acceptance passes should PR #41 merge and the existing backend release process
activate coding. The canonical Nation frontend remains `nation-app-preview/`;
this backend checkout must not replace or deploy that site.

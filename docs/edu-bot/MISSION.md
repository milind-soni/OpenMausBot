# Edu Bot — Mission brief (for the lead agent)

Owner: Eduardo Moraga (GitHub: EduardoMoraga). Repo: https://github.com/EduardoMoraga/edu-bot
(fork of milind-soni/OpenMausBot, remote `upstream`). Eduardo is dyslexic: any text meant for
him (PROGRESS.md, README intro) must be short, plain Spanish (Chile) sentences.

## Goal
Turn this fork into **Edu Bot**: Eduardo's first open-source desktop app for Linux, Windows and
macOS, a Grok-Bot-like roster of AI bots, with the full power of his existing Edu stack.
Quality bar: production grade, 10/10. The user must not hit errors in normal use.

## Product vision
1. Rebrand to Edu Bot everywhere user-facing (name, app id, icons, docs, installer names).
   Apache-2.0: keep LICENSE, NOTICE and attribution to OpenMausBot/Supamaus; remove MausBot
   trademarks/mascot from branding. Do NOT ship or modify `enterprise/` source-available code
   into the OSS product (exclude or remove it cleanly). Disable telemetry/analytics by default.
2. Integrate Edu (https://github.com/EduardoMoraga/edu, local clone ~/Projects/edu, CLI `edu`):
   - Edu brain as the long-term memory of every bot (via `edu mcp` / Edu MCP tools: recall,
     remember with approvals, claim bands). Keep Edu's safety model (workers can't approve or
     write canonical memory without human approval).
   - Edu crew/playbooks available to bots (plan → build → checks → cross-vendor review).
3. Organization model ("emulate a company"): Organization > Workspace (= company area, e.g.
   "BI") > Bot (role with a profile file: purpose, allowed tools/MCP, area memory, model) >
   Person (user who connects their own agent CLI/login). Bots are defined in versioned
   Markdown/YAML so two people with the app get the same bots. Shared area memory through
   edu-cloud (https://github.com/EduardoMoraga/edu-cloud, local ~/Projects/edu-cloud: team
   tokens + MCP memory). Per-bot tool permissions, per-user credentials, audit log.
4. Grounded data tools: pattern from albert-crm (~/Projects/albert-crm): numbers come from SQL
   tools, never from the model. Ship a generic, read-only-by-default SQL connector (Postgres +
   SQLite/DuckDB) with per-bot allowlists.

## How to work (agents and loops)
- Usage limits (added 2026-11-22): if Claude's weekly limit runs out, never stop silently: write "Necesito de Eduardo:
  usar reinicio de límite" in PROGRESS.md and keep going with Codex, Grok and Agy meanwhile.
- You are the lead (Claude Opus). Use Herdr (you run inside it; see `herdr --skill`) to start
  sibling agents in panes: **codex** (frontend/UI), **claude** (backend/harness), **grok** and
  **agy** (independent auditors/reviewers, cross-vendor). Use git worktrees per agent.
- Loop per milestone until green: plan → implement → typecheck, lint, unit tests, build →
  run the app (Linux) and smoke/e2e test real flows → independent audit by a different vendor
  → fix → re-audit. Only close a milestone when the audit finds nothing actionable.
- Keep a short checklist in docs/edu-bot/PROGRESS.md (Spanish, plain) with milestone status,
  what was verified and how. Update it at each milestone.
- Work on branches, open PRs to `main` of EduardoMoraga/edu-bot with gh, merge when green.
  Never force-push main. Never push to `upstream`. Never commit secrets/tokens.
- Cross-platform: CI (GitHub Actions) building Linux, Windows and macOS artifacts; test Linux
  locally on this machine (Omarchy, Arch/Hyprland, Wayland).
- Prefer TypeScript. Prefer model quality over speed.

## Milestones (suggested order)
M0 Repo health: install deps, build and run upstream as-is on Linux; baseline tests green.
M1 Rebrand + license hygiene + telemetry off + remove enterprise from OSS build.
M2 Edu brain integration (memory MCP wired per bot, approvals UI).
M3 Org/workspace/bot profiles in Markdown/YAML + shared memory via edu-cloud.
M4 SQL connector + per-bot permissions + audit log. Also connectors without upstream services (added 2026-11-22,
   after Eduardo tested on his Mac: connectors were unusable because they depend on MausBot's managed Composio broker):
   1) Connected apps work without the MausBot broker: a clear flow with the user's own Composio project key (`ak_`),
      and no copy that mentions MausBot Cloud.
   2) Own MCP servers as a first-class path (Notion, Gmail, Cheil's server, edu-cloud), configurable per bot and per
      area from the UI and from M3's YAML profiles.
   3) Without a key, the Connected apps screen explains in plain words what to do; never broken or empty.
   4) Real end-to-end test of at least one MCP connector and one Composio connector, plus a different-vendor audit.
   5) (added 2026-11-22) Antigravity as a first-class provider so Google's models (Gemini) can be used from the app:
      verify setup/sign-in/model choice/turns end to end with the real `agy` CLI, fix what fails, plus a real e2e test.
M5 Cross-platform CI + installers + README (EN + ES) + first release v0.1.0 of Edu Bot.
M6 Full audit pass (security, UX, docs, error paths) by two different vendors; fix all.
   Also (added 2026-11-22): English and Spanish must be complete and reviewed (no half-translated text, no MausBot
   leftovers), verified in the real app; other languages may stay as they are.

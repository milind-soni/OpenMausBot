<!--
Please read CONTRIBUTING.md first — it's short. One concern per PR;
big changes should have an issue agreeing on the approach before code.
-->

## What changed

## Why

## How it was verified

<!-- commands run, platforms tested on, what you clicked through -->

## Screenshots (UI changes)

<!-- before/after images; video for anything animated -->

## Checklist

- [ ] `pnpm typecheck` and `pnpm test` pass locally
- [ ] Server behavior changes come with tests (see CONTRIBUTING.md → Tests)
- [ ] No `dist-server/` edits (it's build output)
- [ ] macOS-only code is platform-gated; no `shell: true` / cmd.exe string-building
- [ ] No secrets in logs, responses, events, or argv

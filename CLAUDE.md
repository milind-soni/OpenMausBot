# Gerer Build Studio — Claude guidelines

## Development commands

- Development UI: `pnpm dev`
- Harness server: `pnpm dev:server`
- Electron desktop app: `pnpm dev:desktop`
- Type-check: `pnpm typecheck`
- Build: `pnpm build`
- Tests: `pnpm test`

## Project board

The repository-native project board lives in `docs/dev/fixes/`. Read `docs/dev/fixes/README.md` before touching a board file.

- Document prefixes are `todo--`, `doing--`, `review--`, and `done--`.
- Line items use `[ ]`, `[~]`, `[?]`, and `[x]` for the same states.
- Agents may implement work and move it to review, but only the user or a designated reviewer may approve it as done.
- Complex implementations require an approved plan in `docs/dev/plans/`.

## Version control

Commit every repository modification locally with a descriptive message. Never push unless the user explicitly asks. Preserve and exclude unrelated working-tree changes.

See `AGENTS.md` for the authoritative repository instructions and architecture constraints.

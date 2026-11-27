# The headless command line

Use an isolated fixture, never the live app or workspace. The end-to-end test
runs the published `openmausbot` entry as a child process against its own
fake-engine server (ports 19975-19999): a team file makes a Chief, two
teammates and a room, and a second apply sends no write; `run --wait job`
waits until the Chief and both teammates are done, and the export holds the
job tree, three transcripts, the Chief's report and both screenshots. Then
`team export` applies back with no changes, a second file renames a bot
(`was:`) and `--prune` deletes one made by hand, a `native:` tool selection on
a Claude bot is refused before any write, and a job whose teammate hangs is
stopped, teammate included, by `--on-timeout stop`.

```sh
pnpm exec vitest run server/headless-cli.e2e.test.ts
pnpm exec vitest run server/headless/ server/job-view.test.ts server/routes/jobs.test.ts server/mcp-server.test.ts server/control-omb.test.ts
pnpm typecheck
pnpm lint
```

By hand, against a fixture (`OMB_TEST_PORTS` keeps it in a range):

```sh
OMB_TEST_PORTS=19975-19999 node --experimental-strip-types scripts/control-omb.ts launch
pnpm control:omb doctor --url http://127.0.0.1:PORT
pnpm control:omb team apply team.yaml --dry-run --url http://127.0.0.1:PORT
pnpm control:omb team apply team.yaml --url http://127.0.0.1:PORT
pnpm control:omb run --bot ID --text "Say hello" --url http://127.0.0.1:PORT
pnpm control:omb export --thread THREAD_ID --out /tmp/omb-export --url http://127.0.0.1:PORT
```

`control-omb` runs the same verbs as `openmausbot` (docs/headless-cli.md) and
prints each JSON result; a verb that changes something needs the explicit
`--url`. The job a wait watches is the server's own read,
`GET /api/threads/:id/job`; keep its JSON with the run's result as evidence.

The fake engine is scripted (`FAKE_CLAUDE_ROOM_PLAN`), so this proves the
command line, the job read and the export, not real model behaviour or a real
browser's screenshots.

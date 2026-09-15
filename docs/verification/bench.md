# Headless bench driver

## Sub-features

- `POST /api/bench/run` starts one task on one bot as an unattended launch
  (a detached task, the way a routine runs, so the launch budget applies).
- A budget in `steps`, `tokens` and `minutes`; a run that crosses one is
  interrupted and the result names which (`budget_exceeded`, `exceeded`).
- `GET /api/bench/runs/:id` reports the result and, once terminal, the
  trajectory: the thread's messages (with its digest) and its usage rows
  (tokens, prompt shape, evidence coverage).
- `scripts/bench/run.ts` drives the same routes and writes `result.json` and
  `trajectory.json`; exit 0 only when the run settled.
- Works for every engine by construction: the bot's engine is whatever it
  is configured with, and the result records `driverKind` and `model`.

## User path

None. This is the adapter benchmarks and the harness's own regression
fixture call. The task appears in the bot's task list as `bench · …`.

## Driving it

```sh
pnpm exec vitest run --no-file-parallelism server/bench.e2e.test.ts
pnpm exec vitest run server/bench.test.ts
```

By hand, against a fixture:

```sh
node --experimental-strip-types scripts/control-omb.ts launch
pnpm control:omb new-bot --name Runner --url http://127.0.0.1:PORT
pnpm bench:run -- --url http://127.0.0.1:PORT --bot BOT_ID \
  --task "List the files here, then say done." \
  --budget steps=50,tokens=100000,minutes=5 --out /tmp/bench-1
cat /tmp/bench-1/result.json
```

`result.json` must say `"status": "settled"` with `turns: 1`; the
trajectory must contain a `digest` row.

## Gotchas

- `--url` must be an explicit loopback URL; the script never discovers a
  port, so it cannot reach the user's running app by accident.
- `--network allow=…` is recorded on the result and not enforced: no engine
  takes a network allow-list today (`enforced: false`).
- `--cwd` pins the run's task to that folder; the folder must exist.

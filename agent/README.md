# omb-agent

A self-contained development agent for working on OpenMausBot with any cheap
model. It is one plain Node script with no dependencies: it reads, searches,
writes and runs commands inside this repository through OpenRouter's standard
tool-calling API, in a loop, until the task is done.

## Run it

```bash
pnpm agent "Fix the flaky test in server/telephony/door.test.ts and explain why it was flaky"
```

or directly:

```bash
node agent/omb-agent.mjs "task..." [--model owner/model] [--max-turns 25]
```

`OMB_OPENROUTER_API_KEY` (or `OPENROUTER_API_KEY`) authenticates, exactly like
the app's own OpenRouter client.

## Choosing the model

`OMB_AGENT_MODEL` (or `--model`) picks the brain; the default is
`deepseek/deepseek-v4.1-flash`, the background tier's cheap model, because this
harness is for mechanical work: run the tests, fix the lint error, add the
regression test. The model must support OpenRouter tool calling. Swap freely —
the harness has no model-specific code:

```bash
OMB_AGENT_MODEL=z-ai/glm-5.3-flash pnpm agent "..."
```

## What it can and cannot do

- Tools: `list_files`, `read_file`, `grep`, `write_file`, `run`.
- Every path resolves inside the repository; anything escaping it is refused.
- `git push` is refused; the agent never publishes. Commits are left to you.
- `run` executes one shell command in the repository root with a 120-second
  timeout, and reports the real exit code.
- The loop ends when the model replies without tool calls, or at the turn
  budget (`--max-turns`, default 25). Progress goes to stderr, the final
  summary to stdout.

## Verify without a key

```bash
node agent/omb-agent.mjs --self-test
```

exercises every tool against a throwaway fixture directory — including the
refusals (path escapes, absolute paths outside the repo, `git push`) — with no
network access.
